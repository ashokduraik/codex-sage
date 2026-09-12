# Phase 27 — CodeGraph adapter: writer lock, index/sync, validation

- **Layer:** BE
- **Depends on:** Phase 05 (evaluation — **unwritten**; blocks numeric/language decisions), Phase 26
  (`carry.workspacePath`, materialized tree)
- **Unblocks:** Phase 28, 46
- **Size:** 1–2 days
- **Requirements covered:** backend §23, §93, §94, §139; backend/solution.md §4.3 step 4, §4.4, §4.6
  (S4 rows); docs/architecture.md §5 (S4), §7; ADR 0022 (job-level lock — already phase 21)

## 1. Goal

After this phase **S4 `codegraph_update`** runs in the same ingest handler as phases 25–26. The
worker holds the per-project job lock from phase 21/ADR 0022, applies a CodeGraph-specific writer
discipline (no filesystem watch, telemetry off), calls `@colbymchenry/codegraph` through a single
adapter module to either full-index or in-place sync the materialized tree, validates index health
and exclusion accounting, and stashes graph identity on `IngestStageContext.carry` for phase 28.
You can see it working when job events include `Project structure analyzed` and
`Code relationships analyzed`, and a subsequent failed S4 retry resumes without starting a second
graph writer on the same project.

## 2. Why this phase is here

Code intelligence is the structural retrieval path (backend §57, §23); it requires on-disk source
from S3 (26). Phase 05 was meant to lock CodeGraph version, language coverage, and scale numbers —
that document is **not written**, so this phase defines module boundaries and tests with fixtures but
treats evaluation outputs as **implementation blockers** (README decisions D3, plan Part F). S4 must
exist before S5 publish (28) because health and `KnowledgeVersion` attach to a validated graph.
Q&A remains disabled until phase 28 publishes — S4 must not expose a readable graph to chat routes.

## 3. Scope

### In scope

- Replace S4 placeholder in `INGEST_STAGES` with `codegraph_update` (same runner — no second pipeline).
- **`backend/src/modules/codegraph/`** as the **only** import site for `@colbymchenry/codegraph`
  (solution §2).
- Disable CodeGraph filesystem watching and telemetry for every run (architecture §2, solution §2);
  exact mechanism (env vars vs hard-coded process env before import) is **§12**.
- Skip files already marked `excludedFromGraph` on `SourceFile` (phase 25 S2); large-file exclusion
  still forces partial health at publish (28).
- Choose **full index** vs **in-place sync** based on whether a current graph exists for the project
  workspace — trigger rules for incremental sync on re-upload are refined in phase 29; first ingest
  uses full index.
- Post-index **validation**: index status, hash/exclusion probes as required by solution §4.3 step 4
  (exact probe list follows library API discovered at install — not invented here).
- Extend `carry` with graph identity fields needed by phase 28 (e.g. graph path, content hash —
  **shape §12** until library API is known).
- User-language events aligned with backend §30 workflow (`Project structure analyzed`, `Code
  relationships analyzed`).
- Map failures to phase 21 retry taxonomy; bounded `temporary` retries for S4 per solution §4.6.

### Out of scope (owner phase)

- `KnowledgeVersion` insert, project `knowledgeHealth`, lifecycle `knowledge_ready` — **phase 28**.
- Recovery rematerialize from last accepted tree — **phase 28** (may call back into S3/S4 helpers).
- Chat/agent `explore_code` tool — **phase 46** (read lease, not writer).
- Installing or pinning CodeGraph version in this documentation — **`npm view` at implementation**
  per `dependency-versions.mdc`; phase 05 benchmark before locking scale claims.
- Historical graph retention — README §5 (current graph only).

## 4. Design

### 4.1 Two layers of serialization

```text
Phase 21 claim
  → acquire project_job_locks (scope project_writer)   ← ADR 0022
  → run ingest stages …
       S4 codegraph_update:
         → adapter.acquireWriter(project)               ← CodeGraph writer discipline
         → indexAll | sync(materializedPath)
         → validate
         → adapter.releaseWriter
  → release project_job_locks
```

Job-level lock prevents two jobs (ingest / reingest / repo_sync) from mutating the same workspace;
the adapter’s writer lock wraps library calls so API-process read leases (architecture §7) never
overlap mutation. Whether one mutex is sufficient or both are required is **§12**.

### 4.2 S4 `codegraph_update` flow

```text
run(context)
  require context.carry.workspacePath from S3

  adapter.configureTelemetryOff()
  adapter.disableFilesystemWatch()

  filesForGraph = SourceFiles where status A, stored, not excludedFromGraph

  if no existing .codegraph index at workspace:
      await adapter.indexAll(workspacePath, { include: filesForGraph })
  else:
      await adapter.sync(workspacePath, { changedPaths: … })   ← changedPaths from carry; 29 supplies

  validation = await adapter.validate(workspacePath, {
    expectedExclusions: files marked excludedFromGraph,
    sourceVersionId: context.scope.sourceVersionId
  })
  if validation.hardFail: throw classified error

  context.carry.graphIdentity = validation.identity   ← exact fields §12
  emit JobEvents with honest counts from validation
  return StageResult
```

Language/extension allowlist is **provisional** until phase 05; S2 may have marked
`unsupported_language` — S4 must not index those paths.

### 4.3 Adapter module boundary

Public surface (`modules/codegraph/index.js`):

- `createCodegraphAdapter(config)` — factory used by ingest S4 and later read-side tools (46).
- Writer methods: `indexAll`, `sync`, `validate`, `acquireWriter`, `releaseWriter`.
- Read methods (stub or minimal until 46): `explore`, `buildContext` — may throw `NOT_IMPLEMENTED`
  in this phase if unused.

No other module imports `@colbymchenry/codegraph` directly.

### 4.4 Failure handling (S4 rows, solution §4.6)

| Where it fails | Job / Q&A | What is kept | Recovery owner |
|---|---|---|---|
| Transient IO/SQLite lock | Retry `temporary`; Q&A off | Partial workspace/graph possible | Same job checkpoint |
| Validation probe failure | `temporary` or `permanent` by code | Workspace bytes; graph may be partial | 28 recovery path |
| Recovery exhausted | Project knowledge `failed` | Source + diagnostics | 28 + user retry/reingest |
| Worker crash | Sweeper requeues (21) | Checkpoint at last completed stage | Resume S4 |

During S4, chat/search must not read the graph (solution §4.6 hard rule 6) — enforced in 28 gate,
but S4 must not publish partial graph as current.

### 4.5 Integration fixture (solution §4.4)

Before reporting a language/extension as supported in product UI, an integration test must pass for
`.cjs` mapping and each accepted extension — **test list and pass criteria depend on phase 05**.
This phase adds the harness hook and a minimal fixture; expanding coverage waits on evaluation.

## 5. Data model changes

**None required on `jobs`** — checkpoints via phase 21 helpers only.

Optional **ephemeral** graph identity on `stageCheckpoint` / `carry` persisted in job document only
if phase 21 helpers already allow opaque `carry` blob — **do not** add ad-hoc Job schema fields.

`KnowledgeVersion` graph fields are **phase 28** unless storing identity only on job until publish
is insufficient — **§12**.

No new collections in this phase.

## 6. API contract — PROPOSED (needs approval before implementation)

**No HTTP surface.** Internal adapter contract (signatures illustrative until library inspected):

```json
{
  "stage": { "name": "codegraph_update", "run": "(ctx) => Promise<StageResult>" },
  "adapterWriter": {
    "acquireWriter": "(scope: { orgId, projectId }) => Promise<void>",
    "releaseWriter": "() => Promise<void>",
    "indexAll": "(workspacePath, options) => Promise<IndexResult>",
    "sync": "(workspacePath, options) => Promise<SyncResult>",
    "validate": "(workspacePath, options) => Promise<ValidationResult>"
  },
  "validationResult": {
    "ok": true,
    "identity": { "graphPath": "…", "graphHash": "…" },
    "coverage": { "indexedFiles": 4200, "skippedFiles": 12 },
    "probes": [{ "name": "…", "passed": true }]
  },
  "stageFailure": {
    "code": "CODEGRAPH_VALIDATION_FAILED",
    "retryability": "temporary | permanent",
    "message": "Code index validation failed.",
    "details": { "probe": "…" }
  }
}
```

## 7. Configuration & environment variables

Telemetry off is required everywhere (solution §2). Whether to set:

- `CODEGRAPH_TELEMETRY=0`
- `DO_NOT_TRACK=1`

via process env at adapter init, versus documenting them in `.env.example`, is **§12** — do not
assume both are required until confirmed.

**No** Redis, S3, or embedding-related env keys.

### Constants (not env)

| Constant | Home | Purpose |
|---|---|---|
| `CODEGRAPH_S4_STAGE_TIMEOUT_MS` | `stages/s4CodegraphUpdate.js` | Wall-clock budget |
| `CODEGRAPH_VALIDATION_PROBE_TIMEOUT_MS` | `codegraph/codegraph.validate.js` | Per-probe cap |
| `CODEGRAPH_MAX_SYNC_RETRY_ATTEMPTS` | `stages/s4CodegraphUpdate.js` | Bounded temporary retries within one job attempt |

Language list, max nodes for `buildContext`, and concurrency caps are **phase 05 blockers** — not
constants in this plan.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/ingest/stages/s4CodegraphUpdate.js` (+ `.test.js`) | **New:** S4 stage |
| `backend/src/modules/ingest/ingest.stages.js` | **Change:** wire S4 implementation |
| `backend/src/modules/codegraph/index.js` | **New:** public adapter surface |
| `backend/src/modules/codegraph/codegraph.adapter.js` (+ `.test.js`) | **New:** library wrapper |
| `backend/src/modules/codegraph/codegraph.telemetry.js` (+ `.test.js`) | **New:** disable watch/telemetry |
| `backend/src/modules/codegraph/codegraph.validate.js` (+ `.test.js`) | **New:** post-index validation |
| `backend/src/modules/codegraph/codegraph.writerLock.js` (+ `.test.js`) | **New:** in-process writer mutex |
| `backend/src/modules/ingest/ingest.events.js` | **Change:** S4 message builders |
| `backend/package.json` | **Change at implement time:** add `@colbymchenry/codegraph@latest` after `npm view` checks |
| `backend/src/test/fixtures/codegraph/` | **New:** tiny multi-language tree + `.cjs` sample |

## 9. Tests (≥ 80% line and branch)

### Unit (mocked library)

- Telemetry/watch disable invoked before any index call.
- `excludedFromGraph` paths never passed to index/sync.
- Validation failure maps to correct `retryability` and error code.
- Writer lock: concurrent `acquireWriter` same project blocks or queues deterministically.
- Placeholder behavior: missing `workspacePath` → `permanent` misconfiguration error.

### Integration (optional skip if library not installed in CI — document skip reason)

- Full index on fixture workspace produces `.codegraph` under workspace; validate passes.
- Sync path invoked when index pre-exists (simulate second run).
- Job events contain user-language strings without stack traces.

### Unhappy paths

- Library throws → wrapped stage failure with code, not bare Error.
- AbortSignal mid-sync → stage stops, checkpoint at S3 or S4 boundary per runner rules.
- Tenant scope mismatch → no graph mutation.

## 10. Definition of Done

- [ ] S4 replaces placeholder; runs after S3 in the same ingest handler.
- [ ] `@colbymchenry/codegraph` imported only under `modules/codegraph/`.
- [ ] Filesystem watch disabled; telemetry off per approved §12 mechanism.
- [ ] Excluded files skipped; validation runs before stage completes.
- [ ] Graph identity available on `carry` for phase 28.
- [ ] Failures classified for phase 21 retry; no second writer on same project (job lock + adapter).
- [ ] Job schema fields not re-declared; checkpoints via phase 21 helpers.
- [ ] Colocated tests ≥ 80% line and branch on adapter + S4 stage.
- [ ] `npm run lint`, `npm test` pass (integration tests may skip CodeGraph when dependency absent
      if documented in test file and phase 63 CI plan).

## 11. Documentation & ADR updates

- `docs/architecture.md` §5 S4 and §7 writer/read lease: align with implemented lock split.
- `backend/solution.md` §4.4: reference fixture path once tests exist.
- ADR for CodeGraph package pin **after** phase 05 evaluation and `npm view` install — not in this
  documentation-only deliverable.
- If writer-lock split differs from ADR 0022 narrative, add a short ADR supplement or update
  architecture (do not rewrite ADR 0022).

## 12. Risks & open questions

1. **Phase 05 unwritten:** CodeGraph version, supported languages, index duration/RAM/SQLite behavior,
   and `.cjs` coverage gates block production constants and CI expectations.
2. **CodeGraph install and API (cross-cutting Q4):** Exact `indexAll` / `sync` signatures, options,
   and validation hooks — discover at install; this plan does not specify method names.
3. **Writer lock vs job lock (ADR 0022):** Is the adapter mutex redundant with `project_job_locks`, or
   required for API-process read leases during ingest on multi-process deployments?
4. **Telemetry configuration:** Env vars in `.env.example` vs set-only-in-process before import?
5. **`carry.graphIdentity` shape:** Which fields does phase 28 require (`graphHash`, sqlite path,
   index schema version)?
6. **Sync changedPaths source:** Phase 29 supplies diff; for first upload, confirm full index only.
7. **CI without CodeGraph:** Whether phase 63 runs graph integration in CI or skips with documented
   reason — not decided here.
