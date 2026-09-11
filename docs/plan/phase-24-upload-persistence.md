# Phase 24 — Upload persistence: GridFS, SourceVersion, SourceFile

- **Layer:** BE
- **Depends on:** Phase 20 (Job enqueue), Phase 23 (validation + exclusion engine), Phase 12
  (rate limit `upload`, `Idempotency-Key`), Phase 17 (project), Phase 10 (audit writer)
- **Unblocks:** Phase 25 (worker S0–S2), Phase 33 (frontend upload slice)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §10–§13, §92; `backend/solution.md`
  §4.3 step 1, §4.5; `docs/architecture.md` §5

## 1. Goal

After this phase `POST /api/v1/projects/:projectId/sources` authenticates, authorizes
`sources.upload`, runs Phase 23's engine, **streams accepted bytes to GridFS**, inserts
`SourceVersion` + `SourceFile` rows, enqueues a `Job` with `jobType: 'ingest'` and
`jobStatus: 'pending'`, and returns `202 { sourceVersionId, jobId }`. Skipped paths never
hit GridFS. Empty-after-exclude and zip-slip return `400` with no version and no job.

You can see it working with an authenticated upload of a small zip: GridFS contains only
accepted files, two Mongo documents exist, `GET` the job (Phase 20) shows `pending`, and
repeating the same `Idempotency-Key` returns the same `202` body without a second writer.

## 2. Why this phase is here

Architecture §5 puts accept + store + enqueue on the **API process** so the HTTP handler
does not wait for indexing. Solution §4.6 still names worker stage `S1 store_files`; this
plan's split (already used by Phase 25) is:

| When | Who | What |
|---|---|---|
| Request | Phase 24 | Validate (23), write accepted bytes to GridFS, insert rows, enqueue job |
| Worker | Phase 25 S0 | Re-validate recorded metadata (integrity flags, empty set) |
| Worker | Phase 25 S1 | **Reconcile** GridFS vs `SourceFile` (missing/corrupt → `fileState`), not a second full write |
| Worker | Phase 25 S2 | Apply recorded exclusion reasons / leftover ignores |

The HTTP handler still must not index, materialize, or call CodeGraph.

It cannot come before 20 (needs `createPendingJob`) or 23 (must not invent skip rules). It
cannot come after 25 (the worker would have nothing to claim).

## 3. Scope

### In scope

- Multipart/zip upload route on the project.
- Stream zip entries: skip via Phase 23 **before** `openUploadStream`.
- GridFS bucket for accepted source/doc bytes only.
- `SourceVersion` and `SourceFile` models (indexes declared on schemas).
- Enqueue `ingest` job `pending`, audit `source.upload`.
- `202` with ids; `Idempotency-Key` required; rate class `upload`.
- Mark `excludedFromGraph` for >1 MiB accepted files.
- Project lifecycle: if the project was `awaiting_source`, move it to the ingest-in-progress
  state Phase 17 already defined (do not invent a new enum value).

### Out of scope (owner phase)

- Worker stages S0–S6 — **Phases 25–28**.
- Re-upload diff / new version semantics beyond inserting a **new** `SourceVersion` —
  **Phase 29** owns diff against last ready version; this phase always creates a new
  version.
- Repository download into GridFS — **Phase 32**.
- Frontend dialog — **Phase 33**.
- Encrypting the workspace volume — later materialize phase (26).

## 4. Design

### 4.1 Handler flow

```text
JWT → project ACL (sources.upload)
rate class upload
Idempotency-Key required
inspect zip (Phase 23) → fail 400 without writes if slip / integrity / empty
open transaction:
  insert SourceVersion (lifecycle: received / validating — see §5)
  for each accepted entry:
    gridfs.openUploadStream(...)
    insert SourceFile { path, sha256, gridFsId, excludedFromGraph, exclusionReason }
  createPendingJob({ jobType: 'ingest', sourceVersionId, projectId, correlationId })
  audit source.upload (ids and counts only)
commit
202 { sourceVersionId, jobId }
```

If GridFS write fails mid-loop: mark written objects `orphanedAt` where possible, abort the
Mongo transaction (documents), leave orphaned blobs for a later sweeper (Phase 25 S1 /
retention). Do not block the request on a full GC.

SHA-256 is computed while streaming; never log the digest next to path in a way that dumps
file contents. Paths in audit context are allowed (solution §9.1 allows paths).

### 4.2 GridFS conventions

- Bucket name constant `GRIDFS_SOURCE_BUCKET` (`'sourceFiles'`).
- Filename = tenant-safe key: `{orgId}/{projectId}/{sourceVersionId}/{normalizedPath}`
  so a blob is never reached by path alone from another tenant.
- `metadata`: `{ orgId, projectId, sourceVersionId, path, sha256 }` — required for
  sweeps. No user tokens.

Mongoose `createBaseSchema` does not apply to GridFS files; the **`sourceFiles` document**
carries `status: 'A' | 'D'`. GridFS files are deleted only by an explicit purge ADR.

### 4.3 Multipart vs zip

MVP accepts a **zip** (solution §4.1 Archives). Loose multipart file lists can be a second
content-type in this phase **only if** they run through the same per-path engine; otherwise
defer folder-upload flattening to Phase 33/a follow-up. Proposed: zip only in this slice
(§12).

### 4.4 Idempotency

Same key + user + project + route → replay `202` body; no second GridFS write, no second
job (Phase 12). In-flight duplicate waits or `409 IDEMPOTENCY_IN_FLIGHT`.

### 4.5 Authorization and tenancy

`orgId` and `projectId` from the authenticated project record, never from the zip
or query. A file claiming to be from another project is not a concept — paths are relative
inside the archive.

## 5. Data model changes

### `sourceVersions`

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | required |
| `projectId` | ObjectId | required |
| `origin` | `'upload' \| 'repository'` | this phase writes `'upload'` |
| `exclusionRulesetId` | string | from Phase 23 |
| `versionLifecycle` | `'received' \| 'failed' \| 'accepted'` | domain; not row `status`. Start `received`; 25/28 advance |
| `jobId` | ObjectId | pending ingest job |
| `createdBy` | ObjectId | |
| `fileCounts` | `{ accepted, skipped, excludedFromGraph }` | |
| `status` | `'A' \| 'D'` | default `'A'` |
| `createdAt` / `updatedAt` | Date | UTC |

Indexes: `{ orgId, projectId, createdAt: -1 }` partial `status: 'A'`.

### `sourceFiles`

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | required |
| `projectId` | ObjectId | required |
| `sourceVersionId` | ObjectId | required |
| `path` | string | normalized relative path |
| `sha256` | string | hex |
| `byteLength` | number | |
| `kind` | `'code' \| 'config' \| 'doc'` | |
| `gridFsId` | ObjectId | |
| `excludedFromGraph` | boolean | |
| `exclusionReason` | string \| null | e.g. `file_too_large` |
| `fileState` | `'stored' \| 'missing' \| 'corrupt'` | default `'stored'`; 25 S1 may change |
| `orphanedAt` | Date \| null | |
| `status` | `'A' \| 'D'` | default `'A'` |
| `createdAt` / `updatedAt` | Date | UTC |

Index: unique `{ orgId, projectId, sourceVersionId, path }` partial `status: 'A'`.

Skipped paths are **not** `sourceFiles` rows (bytes never stored). Their count lives on
`sourceVersions.fileCounts.skipped` only.

## 6. API contract — PROPOSED (needs approval before implementation)

### `POST /api/v1/projects/:projectId/sources`

- **Permission:** `sources.upload` + project membership (Phase 18 when present).
- **Rate class:** `upload`.
- **Headers:** `Idempotency-Key` **required**.
- **Body:** `multipart/form-data` with field `archive` (zip). Max size = Phase 23
  `UPLOAD_MAX_ARCHIVE_BYTES`.
- **Response `202`:**

```json
{
  "sourceVersionId": "665a00000000000000000001",
  "jobId": "665f1c9d4b2a8e0012a4f001"
}
```

- **Errors:** `400 SOURCE_ZIP_SLIP`, `400 SOURCE_ZIP_INTEGRITY`,
  `400 SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS`, `400 VALIDATION_ERROR`,
  `401`, `403`, `404` (project), `409 IDEMPOTENCY_KEY_REUSE`,
  `409 IDEMPOTENCY_IN_FLIGHT`, `429 RATE_LIMITED`.

No file bytes, no zip listing in the success body. Processing status is the job (Phase 20).

## 7. Configuration & environment variables

**None.** Bucket name, max parts, and hash algorithm are constants.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `GRIDFS_SOURCE_BUCKET` | `'sourceFiles'` | `modules/sources/sources.constants.js` | Bucket name |
| `UPLOAD_HASH_ALGORITHM` | `'sha256'` | same | Content hash |
| `MULTIPART_MAX_FILES` | `1` | same | One archive field |

Reuse Phase 23 size constants; do not duplicate as env.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/sources/sourceVersion.model.js` | **New** |
| `backend/src/modules/sources/sourceFile.model.js` | **New** |
| `backend/src/modules/sources/sources.repository.js` | **New** |
| `backend/src/modules/sources/upload.service.js` | **New:** stream + persist + enqueue |
| `backend/src/modules/sources/upload.routes.js` | **New** |
| `backend/src/modules/sources/gridfs.js` | **New:** bucket helper |
| `backend/src/modules/sources/index.js` | **New** |
| colocated tests | **New** |
| `backend/src/http/routes.js` | Register upload route |
| `backend/src/http/app.js` | Multipart parser if not already; size cap from constants |

`@fastify/multipart` (or the project's existing parser) is added only after
`dependency-versions.mdc` pre-install checks.

## 9. Tests (≥ 80% line and branch)

### Unit

- Service refuses to open GridFS for a `skip` decision.
- `excludedFromGraph` set for oversize accepted files.
- Mapper never includes `gridFsId` in a way that leaks another tenant (detail APIs later;
  this route returns only two ids).

### Integration (harness + GridFS on the test database)

- Happy zip: one accepted file in GridFS, matching `SourceFile`, job `pending`, `202`.
- Zip with only `node_modules`: `400`, zero GridFS files, zero jobs, zero versions.
- Zip-slip: `400`, no writes.
- Same `Idempotency-Key`: one version, one job, identical `202`.
- Cross-tenant project id → `404`.
- Missing permission → `403`.
- Missing idempotency key → `400`.
- Audit row has counts, not bytes.
- Failed mid-write: transaction aborted; no committed `SourceVersion` (orphans may exist and
  are marked or asserted leftover-only in test db).

## 10. Definition of Done

- [ ] Accepted bytes are in GridFS; skipped paths are not.
- [ ] `202 { sourceVersionId, jobId }` and a `pending` ingest job exist.
- [ ] Empty-after-exclude and zip-slip do not create a version or job.
- [ ] Idempotent replay creates no second writer.
- [ ] HTTP handler does not run S3–S6 or wait for the worker.
- [ ] No new `.env` keys.
- [ ] Packages added only after pre-install checks.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/data-model.md`: `sourceVersions`, `sourceFiles`, GridFS bucket metadata.
- `docs/architecture.md` §5: reconcile the diagram so **API writes GridFS** and worker S1
  **reconciles** (today the diagram lists both). Do that in this change so Phase 25 stays
  consistent.
- `backend/solution.md` §4.3 step 1 already matches this phase; §4.6 S1 wording is
  worker-oriented — add a sentence that S1 is reconciliation when the API already stored
  bytes.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Zip only vs multipart file list.** Proposal: zip only in this slice.
2. **Project lifecycle transition** on first upload. Which Phase 17 `lifecycleStatus` is
   written (`importing` / `processing` / existing enum)? Must match Phase 17 exactly —
   do not add a new value here.
3. **Return skipped counts in `202`?** Proposal: no; the job events (25) carry
   "Exclusions applied (N paths)". Confirm.
4. **GridFS on the test database.** Same rewritten URI as Phase 03 (`codex_sage_test`).
   Confirm no separate bucket/host.
5. **`versionLifecycle` names.** Proposed `'received' \| 'failed' \| 'accepted'`. Phase 28
   may need `published`; if so, add it there, not here.
