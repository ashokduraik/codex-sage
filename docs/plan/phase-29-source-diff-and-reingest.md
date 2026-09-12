# Phase 29 — Source diff, re-ingest, retry & resume

- **Layer:** BE
- **Depends on:** Phase 28 (published `KnowledgeVersion`, Q&A gate, end-to-end ingest through S6)
- **Unblocks:** Phase 32, 39
- **Size:** 1–2 days
- **Requirements covered:** backend §11–13, §21, §27, §37, §83; backend/solution.md §4.7–§4.8;
  docs/architecture.md §5 (re-upload diff)

## 1. Goal

After this phase the platform can **compare** a new `SourceVersion` to the last successfully published
one by `path + sha256`, persist a change summary for later UI/API (phase 39), pass **unchanged paths**
into S3/S4 so document re-index and graph sync skip stable files, and expose **`POST …/reingest`**
to rebuild knowledge from **existing GridFS bytes** without a new upload. Job **retry** remains phase
22 (`POST …/jobs/:jobId/retry` — same job, checkpoint resume); this phase distinguishes retry vs
re-ingest vs replace-source in behavior and copy (backend §37, solution §4.7). Duplicate reingest
clicks with the same `Idempotency-Key` return the active job, not a second writer (phase 12, ADR 0022).

## 2. Why this phase is here

Phase 24 always creates a new `SourceVersion` on upload; phase 28 publishes knowledge for one
version at a time. Requirements §11–13 and §21 expect tracked updates, deduplication where safe, and
impact visibility (§83). Solution §4.8 describes diff-driven incremental work on re-upload **before**
S3–S5 under the same writer lock — that logic cannot run until publish exists (28). Repository sync
(32) reuses the same diff and ingest path with `origin: github|gitlab`. HTTP reingest is separate
from upload: same bytes, new job, full rebuild of sections/graph (solution §4.7 table).

## 3. Scope

### In scope

- **Diff engine:** compare version **N+1** (incoming job) to **last published** source version
  (via `KnowledgeVersion` → `sourceVersionId`), producing:
  - `added`, `removed`, `changed`, `unchanged` path sets (solution §4.8).
- **Persisted change summary** for phase 39 — storage shape **§12** (collection vs fields on
  `SourceVersion`).
- Wire diff output into ingest **`IngestStageContext.carry`**: `skipPaths` (unchanged), `changedPaths`
  (for S4 sync — phase 27 adapter).
- On **new upload** ingest: project → `updating` via `transitionLifecycle` when approved gate timing
  (§12); enqueue uses existing `jobType: ingest`.
- **`POST /api/v1/projects/:projectId/sources/:sourceVersionId/reingest`**: permission
  `knowledge.trigger`; idempotent; `202 { jobId }`; enqueues rebuild from stored bytes.
- **`jobType: reingest`** listed in data-model — **confirm vs ingest + intent flag §12**.
- User-visible distinction documented for FE phase 35: retry failed steps vs re-ingest vs upload new
  source (backend §37, solution §4.7).
- Re-run exclusion rules: phase 25 Q5 / cross-cutting Q8 — **not decided here**.

### Out of scope (owner phase)

- Git fetch, `repo_sync`, scheduler — **phase 32**.
- HTTP change-summary and preview — **phase 39** (consumes persisted diff).
- Job cancel/retry HTTP — **phase 22** (this phase only documents interaction).
- Additional-docs-only upload semantics (backend §11) — **§12**.
- Commit SHA comparison — **phase 32**.

## 4. Design

### 4.1 Three operations (solution §4.7)

| Operation | Entry | SourceVersion | Job |
|---|---|---|---|
| Retry failed | `POST …/jobs/:jobId/retry` (22) | unchanged | same job, resume checkpoint |
| Re-ingest version | `POST …/sources/:id/reingest` (this phase) | unchanged | **new** job, pipeline from S0 or S3 policy §12 |
| Replace source | `POST …/sources` upload (24) | **new** | new `ingest` job + diff vs last published |

This phase implements the middle row and the **diff portion** of the third row inside the ingest
handler when `sourceVersionId` differs from last published.

### 4.2 Diff timing

```text
Worker ingest job claimed (version N+1)
  after S0 validate (source version belongs to project, status A)
  lastPublished = load from project.currentKnowledgeVersionId → sourceVersionId
  if no prior published:
      diff = all paths → added (no skip optimization)
  else:
      diff = compare(N+1, lastPublished) on path + sha256 from SourceFile rows
  persist summary for 39
  context.carry.skipPaths = diff.unchanged
  context.carry.changedPaths = diff.changed + diff.added
  S3 uses skipPaths; S4 sync uses changedPaths; removed paths → delete from workspace + soft-delete doc sections
```

**Deduplication (§13):** unchanged paths skip re-index work; correctness requires hash equality,
not mtime alone.

### 4.3 Re-ingest job flow

```text
POST reingest
  auth + project ACL + knowledge.trigger
  Idempotency-Key → existing active reingest/ingest for same sourceVersionId → 202 same jobId
  create job jobType reingest? (§12), sourceVersionId, pending
  202 { jobId }

Worker:
  same handler as ingest (phase 25 registry)
  diff vs last published may treat all paths as changed (full rebuild) — **§12**
  run S0–S6 (or skip S0 if policy allows trusted bytes)
  project lifecycle updating → publish via 28
```

Full rebuild vs incremental on reingest is **§12** — solution §4.7 says “regenerate document
sections and current graph” for reingest API.

### 4.4 Removed paths

For paths in `diff.removed`:

- Delete file under `carry.workspacePath` if present.
- Soft-delete `DocumentSection` rows for that path/version.
- CodeGraph sync must drop removed paths — adapter options **§12** pending library API.

### 4.5 Concurrency

- One writer per project (ADR 0022): second reingest while ingest running → idempotency or
  `project_busy_requeued` behavior from phase 21, not duplicate writers.
- Q&A gate (28) applies during updating/reingest.

### 4.6 Failure handling

| Scenario | Behavior |
|---|---|
| Diff target missing (no published version) | Treat as full ingest; no skip |
| SourceVersion soft-deleted | `404` on reingest API |
| Active job exists, different idempotency key | `409` or queue — **§12** |
| Reingest during repo_sync | Serialized by project lock |

## 5. Data model changes

### Option A — fields on `sourceVersions` (PROPOSED until §12 decides)

Additive on existing collection:

- `changeSummary`: `{ baseSourceVersionId, added, removed, changed, unchanged counts, computedAt }`
- `diffStatus`: `pending | computed | failed`

### Option B — `sourceChangeSummaries` collection

Separate rows keyed by `{ orgId, projectId, sourceVersionId }`, `status: 'A'|'D'`.

**Do not implement both** — product picks in §12.

**`jobs`:** confirm `jobType: 'reingest'` enum in phase 20 schema if not already present; no new
job checkpoint fields.

## 6. API contract — PROPOSED (needs approval before implementation)

### Re-ingest

```http
POST /api/v1/projects/:projectId/sources/:sourceVersionId/reingest
Headers: Authorization, Idempotency-Key (required)
Permission: knowledge.trigger
```

**202 Accepted**

```json
{
  "jobId": "job_01J…",
  "sourceVersionId": "sv_01J…",
  "jobType": "reingest"
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 404 | `SOURCE_VERSION_NOT_FOUND` | Unknown or soft-deleted version / wrong project |
| 409 | `JOB_ALREADY_ACTIVE` | Non-idempotent duplicate while job running |
| 403 | `FORBIDDEN` | Missing permission or project ACL |

### Internal diff DTO (worker)

```json
{
  "baseSourceVersionId": "sv_…",
  "incomingSourceVersionId": "sv_…",
  "added": ["src/new.js"],
  "removed": ["docs/old.md"],
  "changed": ["src/app.js"],
  "unchanged": ["README.md"],
  "counts": { "added": 1, "removed": 1, "changed": 1, "unchanged": 1 }
}
```

Retry API remains defined in phase 22 — not duplicated here.

## 7. Configuration & environment variables

**None.**

### Constants (not env)

| Constant | Home | Purpose |
|---|---|---|
| `SOURCE_DIFF_BATCH_SIZE` | `modules/sources/sourceDiff.js` | Paths loaded per query batch |
| `REINGEST_IDEMPOTENCY_TTL_MS` | routes layer with phase 12 | Align with idempotency record expiry |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/sources/sourceDiff.js` (+ `.test.js`) | **New:** path+sha256 diff |
| `backend/src/modules/sources/sourceChangeSummary.repository.js` (+ `.test.js`) | **New:** persist summary |
| `backend/src/modules/sources/sources.routes.js` | **Change:** POST reingest |
| `backend/src/modules/sources/sources.service.js` (+ `.test.js`) | **Change:** enqueue reingest job |
| `backend/src/modules/ingest/ingest.handler.js` | **Change:** run diff hook post-S0 |
| `backend/src/modules/ingest/stages/s3MaterializeDocs.js` | **Change:** honor `carry.skipPaths` |
| `backend/src/modules/ingest/stages/s4CodegraphUpdate.js` | **Change:** honor `carry.changedPaths` |
| `backend/src/modules/projects/project.lifecycle.js` | **Change:** `updating` on new version ingest |
| `backend/src/modules/jobs/jobs.repository.js` | **Change:** create `reingest` pending job helper |
| `backend/src/platform/errorCatalog.js` | **Change:** codes for reingest conflicts |
| `docs/data-model.md` | **Change:** change summary storage |

## 9. Tests (≥ 80% line and branch)

### Unit

- Diff classifies added/removed/changed/unchanged correctly for fixture file sets.
- Empty prior version → all paths added; no skip paths.
- `skipPaths` and `changedPaths` derived consistently from diff output.

### Integration

- Upload v2 after v1 published: unchanged doc not re-parsed (mock/spy on parser); changed file
  re-indexed.
- Reingest API: 202, idempotent replay returns same `jobId`; job completes through S6.
- Retry API (22) on failed job still resumes checkpoint — regression test that reingest does not
  break retry.

### Unhappy paths

- Reingest on wrong `projectId` → 404.
- Concurrent ingest + reingest → single writer; second job requeued or 409 per §12.
- Cross-tenant source version id → 404, no job created.

## 10. Definition of Done

- [ ] Diff by `path + sha256` against last **published** source version implemented and persisted.
- [ ] S3/S4 honor skip/changed path sets when diff runs on new upload ingest.
- [ ] `POST …/reingest` PROPOSED contract implemented after approval.
- [ ] Idempotency prevents duplicate writers for same reingest intent.
- [ ] Distinct behavior documented vs phase 22 retry and vs new upload.
- [ ] Project `updating` lifecycle wired for source updates per approved §12 timing.
- [ ] `status: 'A'|'D'` on any new summary collection/fields.
- [ ] Job fields written through phase 20/21 helpers only.
- [ ] `docs/data-model.md` updated.
- [ ] `npm run lint`, `npm test`; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `backend/solution.md` §4.7–§4.8: cross-check diff and reingest wording after implementation.
- `docs/architecture.md` §5 re-upload paragraph: align with skip-path optimization.
- Phase 39 plan can cite persisted summary shape once §12 resolves storage.
- ADR only if reingest vs ingest job type split is a new architectural decision.

## 12. Risks & open questions

1. **Persist diff vs compute-on-read:** Should change summaries be stored on `SourceVersion`, a side
   collection, or computed for API only?
2. **Reingest job type (cross-cutting):** Separate `jobType: reingest` vs `ingest` with
   `intent: reingest` flag on the job document?
3. **Reingest pipeline entry stage:** Full pipeline from S0 vs start at S3 for trusted stored bytes?
4. **Exclusion replay (cross-cutting Q8, phase 25 Q5):** On reingest/re-upload, use exclusion rules
   frozen on `SourceVersion` or current phase 23 engine?
5. **Additional-docs-only upload (backend §11):** Is partial tree merge supported or must every upload
   be a full project tree?
6. **Impact analysis (§83):** Mapping file paths to “Authentication workflow” is not defined in
   solution — phase 39 may show file lists only until impact graph exists.
7. **409 vs busy requeue:** When user triggers reingest while ingest runs, return HTTP conflict or
   accept and let phase 21 delay the job?
