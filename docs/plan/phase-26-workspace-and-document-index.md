# Phase 26 — Workspace materialization, document sections & full-text index

- **Layer:** BE
- **Depends on:** Phase 25 (ingest handler, `INGEST_STAGES`, `IngestStageContext`, S0–S2)
- **Unblocks:** Phase 27, 38, 39, 46
- **Size:** 1–2 days
- **Requirements covered:** backend §22, §23, §57; backend/solution.md §4.3 step 3, §4.5, §4.6 (S3 row);
  docs/architecture.md §5 (S3)

## 1. Goal

After this phase the ingest pipeline’s **S3 `materialize_docs`** stage is real instead of a
placeholder. The worker recreates the tenant/project workspace tree from accepted GridFS bytes,
writes every non-excluded file to disk under a configured root, splits Markdown/MDX/plain-text into
scoped `DocumentSection` rows with a MongoDB text index, and emits user-readable job events such as
`Documentation identified (N files)` and `Project files materialized (N paths)`. You can see it
working by running a fixture ingest through S0–S3: the workspace directory mirrors accepted paths,
document sections exist for `.md`/`.mdx`/`.txt` only, and killing the worker mid-S3 resumes from the
last path cursor without duplicating sections.

## 2. Why this phase is here

Phase 25 stops at exclusions applied; CodeGraph (27) and document search (38) need bytes on disk and
indexed document text in Mongo, respectively. S3 must exist before S4 because the graph indexer reads
the **materialized current tree** (solution §4.3 step 4, architecture §5). It cannot come earlier:
S1/S2 must reconcile GridFS and exclusion flags first. Path-based skip for unchanged files on
**re-upload** is owned by phase 29; this phase implements full rematerialize for a given
`sourceVersionId` and accepts an optional skip-path set on `context.carry` when a later phase
supplies it.

## 3. Scope

### In scope

- Replace the S3 placeholder in `INGEST_STAGES` with `materialize_docs` — same runner as phase 25,
  no second pipeline.
- Workspace layout under `{WORKSPACE_ROOT}/{orgId}/{projectId}/` (architecture §3); tenant-safe path
  join so `..`, absolute prefixes, and symlink escapes fail closed (backend §16, phase 25 S0).
- Stream GridFS → disk for every `SourceFile` with row `status: 'A'`, `fileState: 'stored'`, and not
  excluded by S2 (docs and code alike land in the tree; only graph exclusion is separate).
- Idempotent rematerialize for the **current** tree: clear and rewrite the project workspace subtree
  for this ingest (not a second historical tree on disk — solution §4.5, README §5).
- `DocumentSection` Mongoose model: org/project/`sourceVersionId`/path/heading/line range/searchable
  text, row `status: 'A' | 'D'`.
- MongoDB text index on section text (scoped queries always filter `orgId`, `projectId`,
  `sourceVersionId`, `status: 'A'`).
- Intra-stage cursor (last materialized path) + progress flush through phase 21 job helpers.
- Extend `IngestStageContext.carry` with `workspacePath` (absolute path to project root).
- User-language `JobEvent`s for materialization and documentation indexing (backend §34, §30 workflow
  “Documentation identified”).
- S3 row of solution §4.6 failure matrix (warn vs fail — policy not decided here; see §12).

### Out of scope (owner phase)

- CodeGraph index/sync, writer lock, validation probes — **phase 27** (S4).
- `KnowledgeVersion`, project `knowledgeHealth`, lifecycle publish, Q&A gate — **phase 28** (S5/S6).
- Diff by `path + sha256`, unchanged-path skip on new versions, `reingest` HTTP — **phase 29**.
- HTTP browse/search/preview — **phases 37–39**; agent tools — **phase 46**.
- Application-level encryption implementation if ops-only volume encryption suffices — **§12**.
- Embeddings, vector search, image ingest — README §5.

## 4. Design

### 4.1 Placement in the existing runner

```text
INGEST_STAGES (phase 25)
  …
  S2 exclude_apply          ← done in 25
  S3 materialize_docs       ← this phase (replaces NOT_IMPLEMENTED placeholder)
  S4 codegraph_update       ← placeholder until 27
  …
```

The handler calls `stage.run(context)`; on success it persists `lastCompletedStage: 'materialize_docs'`
via phase 20/21 runtime helpers only — **do not** redeclare `currentStage` or `stageCheckpoint` on
the Job schema.

### 4.2 S3 `materialize_docs` flow

```text
run(context)
  workspacePath = join(WORKSPACE_ROOT, orgId, projectId)
  context.carry.workspacePath = workspacePath

  if cursor.path:
      resume from next path after cursor.path in sorted SourceFile list
  else:
      remove existing files under workspacePath (not WORKSPACE_ROOT itself)
      soft-delete prior DocumentSection rows for this sourceVersionId (status → 'D')

  for each SourceFile (sorted by path, batched):
    if context.carry.skipPaths?.has(path): continue   ← supplied by phase 29 when wired
    assert path safe vs workspacePath
    stream GridFS → disk file (create parent dirs)
    if kind is doc (.md, .mdx, .txt per solution §4.1):
        parse → N DocumentSection rows (insert status 'A')
        on single-doc failure: record warning; continue or fail per §12 policy
    emit progress + optional cursor every batch
    context.saveProgress()

  emit JobEvent: materialization complete + doc counts
  return StageResult
```

**Code files** are materialized to disk but do **not** create `DocumentSection` rows (backend §22:
docs are first-class for FTS; code is for CodeGraph in S4).

### 4.3 Document splitting

Parsing uses the `unified` / `remark` stack named in solution §2 (exact package versions are chosen
at install time per `dependency-versions.mdc`). Sections carry:

- `path`, optional `heading` (from nearest heading node), `startLine` / `endLine`, `text` (plain,
  capped per §12 grain question).

Queries for chat/search (phase 38) will filter `sourceVersionId` to the **current published**
version; during ingest, sections are tied to the in-flight `sourceVersionId` on the job.

### 4.4 Path safety and tenant isolation

- Every read/write uses `context.scope.orgId`, `projectId`, `sourceVersionId` from the claimed job —
  never from stage input.
- Resolved disk path must stay under `workspacePath`; violation → `permanent` failure with a path-safety
  code (same class as phase 25 S0).
- Cross-tenant job/source mismatch → abort before mutating disk or Mongo.

### 4.5 Failure handling (S3 row, solution §4.6)

| Condition | Default handling (implementation follows approved policy from §12) |
|---|---|
| Disk full / IO error mid-file | Stage fails `temporary`; cursor at last fully written file |
| GridFS read error | Same file → warning or fail file; continue unless policy says fail job |
| Single document parse error | Staged sections for other docs kept; per-doc retry on job retry |
| Empty project (no doc files) | Stage **completes**; event reflects `0` documentation files |
| Org/project scope mismatch | `permanent`; no writes |

Good document sections from a partial run remain in Mongo until the next S3 run soft-deletes rows
for that `sourceVersionId` and rebuilds (idempotent rematerialize).

### 4.6 Job events (user language)

At minimum:

- After tree write: `Project files materialized (N paths)` — `N` = files written this run.
- After doc indexing: `Documentation identified (N files, M sections)` — only doc paths; omit failed
  clause when zero failures.

Structured counts live in `JobEvent.data` (frontend §26); messages contain no stack traces, job ids,
or raw paths in the headline text.

## 5. Data model changes

Additive; sync indexes via phase 03 `syncSchemaIndexes`.

### `documentSections` (new collection)

| Field | Notes |
|---|---|
| Base | `orgId`, `projectId`, `status: 'A' \| 'D'`, `createdAt`, `updatedAt`, actors |
| `sourceVersionId` | ObjectId → source version being indexed |
| `path` | Repo-relative, normalized |
| `heading` | string or null |
| `startLine`, `endLine` | inclusive line numbers in source file |
| `text` | Searchable plain text (bounded length — cap is a named constant, not env) |
| `sectionIndex` | Stable order within file (0-based) |

Indexes (partial `status: 'A'`):

- `{ orgId, projectId, sourceVersionId, path, sectionIndex }` — list/replace per file.
- Text index on `text` with weights; compound filter fields as required by Mongo text query patterns
  used in phase 38 (exact index definition PROPOSED until search phase confirms queries).

**`jobs`** — owned by phase 20; write checkpoints/counters only through phase 21 helpers.

**`sourceFiles`** — no schema change required if phase 24/25 already expose kind/path/gridFsId; S3
reads existing fields.

## 6. API contract — PROPOSED (needs approval before implementation)

**This phase adds no HTTP surface** — worker-only. Internal contract extension for later stages:

```json
{
  "stage": { "name": "materialize_docs", "run": "(ctx: IngestStageContext) => Promise<StageResult>" },
  "carryExtension": {
    "workspacePath": "/…/WORKSPACE_ROOT/orgId/projectId",
    "skipPaths": "optional Set<string> — phase 29"
  },
  "stageResult": {
    "outcome": "completed | completed_with_warnings",
    "cursor": { "path": "docs/guide.md" },
    "warnings": [{ "code": "DOCUMENT_PARSE_FAILED", "path": "docs/broken.md" }]
  },
  "documentSection": {
    "orgId": "…",
    "projectId": "…",
    "sourceVersionId": "…",
    "path": "docs/auth.md",
    "heading": "Login flow",
    "startLine": 10,
    "endLine": 42,
    "text": "…",
    "status": "A"
  }
}
```

## 7. Configuration & environment variables

| Name | Where | Purpose |
|---|---|---|
| `WORKSPACE_ROOT` | `.env` / `backend/.env` (document in `.env.example`) | Absolute path to encrypted volume root; **must** differ per machine/environment |

No other new env keys unless §12 decides application-level encryption requires a key material env.

### Constants (not env)

| Constant | Suggested home | Purpose |
|---|---|---|
| `WORKSPACE_MATERIALIZE_BATCH_SIZE` | `modules/ingest/stages/s3MaterializeDocs.js` | Files per batch before cursor flush |
| `DOCUMENT_SECTION_MAX_CHARS` | `modules/documents/documentSection.parse.js` | Cap section text stored for FTS |
| `INGEST_S3_STAGE_TIMEOUT_MS` | `modules/ingest/stages/s3MaterializeDocs.js` | Wall-clock budget → `temporary` abort |
| `DOCUMENT_PARSE_CONCURRENCY` | `modules/documents/documentSection.parse.js` | Parallel doc parses within a batch |

Values are chosen at implementation time; do not invent production tunables in `.env`.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/ingest/stages/s3MaterializeDocs.js` (+ `.test.js`) | **New:** S3 stage implementation |
| `backend/src/modules/ingest/ingest.stages.js` | **Change:** wire real S3; keep S4+ placeholders |
| `backend/src/modules/documents/index.js` | **New:** public surface |
| `backend/src/modules/documents/documentSection.model.js` | **New:** schema + indexes |
| `backend/src/modules/documents/documentSection.repository.js` (+ `.test.js`) | **New:** tenant-scoped CRUD, soft-delete by version |
| `backend/src/modules/documents/documentSection.parse.js` (+ `.test.js`) | **New:** remark/unified split → section DTOs |
| `backend/src/modules/workspace/workspacePaths.js` (+ `.test.js`) | **New:** safe join, assert under root |
| `backend/src/modules/workspace/workspaceMaterialize.js` (+ `.test.js`) | **New:** GridFS stream to disk, tree reset |
| `backend/src/modules/ingest/ingest.events.js` | **Change:** S3 message builders |
| `backend/src/modules/ingest/ingest.context.js` | **Change:** initialize `carry.workspacePath` |
| `backend/src/platform/config.js` | **Change:** validate `WORKSPACE_ROOT` (required in non-test when worker runs S3) |
| `backend/.env.example` / `backend/.env` | **Change:** add `WORKSPACE_ROOT` key only |
| `backend/src/test/fixtures/ingest/with-docs/` | **New:** small tree with `.md` and code files |

## 9. Tests (≥ 80% line and branch)

### Unit

- Path join rejects `..`, absolute paths, and resolved paths outside `workspacePath`.
- Doc parser produces ordered sections with headings and line ranges for fixture Markdown/MDX.
- Non-doc extensions materialize to disk but create zero `DocumentSection` rows.
- Cursor resume skips already-written paths and does not duplicate sections.
- Warnings carry codes; stage failures map to phase 21 retryability classes.

### Integration (Mongo + GridFS harness, temp workspace dir)

- S0→S3 on fixture: disk tree matches accepted files; text index exists; events emitted.
- Re-run S3 for same version: old sections soft-deleted; new rows replace; idempotent file bytes.
- Abort `signal` mid-batch: cursor persisted; second run completes remainder.
- Job `orgId` ≠ source version → no disk/Mongo mutations.

### Unhappy paths

- Missing GridFS object for a stored row → file-level warning or stage fail per approved policy.
- Workspace root not writable → `temporary`.
- Project with zero doc files → stage completes with zero section count.

## 10. Definition of Done

- [ ] S3 `materialize_docs` replaces the placeholder in `INGEST_STAGES` and runs after S2.
- [ ] Workspace tree recreated under `WORKSPACE_ROOT/{orgId}/{projectId}/` with path safety enforced.
- [ ] `DocumentSection` collection exists with `status: 'A'|'D'` and text index synced in tests.
- [ ] `context.carry.workspacePath` set for phase 27.
- [ ] Checkpoint/cursor resume proven by test; no duplicate sections on re-run.
- [ ] User-language job events with honest counts; no fabricated percentages.
- [ ] Job fields written only through phase 21 helpers; Job schema not re-declared here.
- [ ] `WORKSPACE_ROOT` documented in `.env.example`; no tunable batch/timeout keys in `.env`.
- [ ] `docs/data-model.md` updated with `documentSections`.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch on touched modules.

## 11. Documentation & ADR updates

- `docs/data-model.md`: add `documentSections` fields and indexes.
- `docs/architecture.md` §5: confirm S3 description matches implemented stage name
  `materialize_docs`.
- `backend/solution.md` §4.3 step 3 and §4.5: no change unless implementation contradicts.
- New ADR **only if** §12 resolves application-level workspace encryption (not expected in this phase).

## 12. Risks & open questions

1. **Workspace encryption (cross-cutting Q1):** Architecture references an encrypted volume. Is
   protection entirely OS/volume encryption (ops, out of D11) with only `WORKSPACE_ROOT` in `.env`,
   or is application-level file encryption required (which would imply additional env/key handling)?
2. **S3 failure policy (cross-cutting Q2):** Solution §4.6 allows document indexing to “warn or
   fail by policy” when individual documents fail. Which behavior is product-default?
3. **Document section grain (cross-cutting Q3):** Heading-based sections only, fixed line windows
   only, or a combination?
4. **MDX parsing:** Solution names MDX as supported — which remark/rehype plugins are in scope for
   MVP (package list pinned at install time)?
5. **`DOCUMENT_SECTION_MAX_CHARS`:** Maximum stored section size for FTS — not specified in
   requirements; needs product input before locking constant.
6. **Soft-delete vs hard-delete prior sections:** This plan soft-deletes by `sourceVersionId` on
   rematerialize; confirm retention/purge expectations with phase 60.
