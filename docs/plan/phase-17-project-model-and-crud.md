# Phase 17 — Project model, CRUD & lifecycle states

- **Layer:** BE
- **Depends on:** Phase 09 (RBAC engine), Phase 10 (audit writer), Phase 12 (`Idempotency-Key`
  on create)
- **Unblocks:** Phase 18, 19, 20, 23, 24, 30, 41 (every project-scoped resource)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §7 (project model), §9 (project creation
  and states), §85 (knowledge health), §86–§87 (audit), §102 (deletion), §111 (import state),
  §112 (knowledge readiness), §152 (authoritative state), §153 (consistent transitions);
  `frontend/requirments.md` §9 (lifecycle states), §81B (archive and deletion);
  `backend/solution.md` §8.1 (domain model), §8.4 (admin API surface), §9.2 (audited actions);
  `docs/architecture.md` §3 (what lives where)

## 1. Goal

After this phase the backend owns the **`Project` collection**, a **single lifecycle state
machine** with exactly the ten states in backend §9, a separate **`knowledgeHealth`** field, and
the CRUD surface the UI needs: create (both the upload and the repository path start here),
list with keyset pagination, get, patch, settings patch, archive, restore, and soft delete.

You can see it working with an authenticated `POST /api/v1/projects`: the response carries
`lifecycleStatus: "awaiting_source"` or `"connecting_repository"`, the project appears in
`GET /api/v1/projects`, an `AuditEvent` row exists for the creation, a forged
`orgId` in the body is ignored, and any attempt to set `knowledge_ready` over HTTP is
rejected with `409 INVALID_STATE_TRANSITION`.

## 2. Why this phase is here

Projects are the tenant's second scoping key: jobs (Phase 20), source versions (Phase 24),
repositories (Phase 30), conversations (Phase 41) and every retrieval path are keyed by
`orgId + projectId`. None of them can be written before the collection and its state
machine exist.

It cannot come earlier because every route needs the RBAC preHandler from Phase 09 and the
audit writer from Phase 10 — project create, settings change and delete are audited actions
(solution §9.2). It must not come later because Phase 19 (frontend projects slice) and Phase 20
(jobs) both consume this model directly.

Project-scoped authorization (the `projects.members[]` overlay) is deliberately **not** here: it is
Phase 18, which retrofits the guard onto the routes this phase creates.

## 3. Scope

### In scope

- `Project` Mongoose model with row `status: 'A' | 'D'`, `lifecycleStatus`, `knowledgeHealth`.
- A lifecycle transition table with invalid transitions rejected (backend §153).
- The rule that `knowledge_ready` / `partially_available` can only be reached from the worker
  publish path with a knowledge-version argument (backend §111, §112; solution §4.6 hard rule 2).
- `projects` module: `routes + service + repository + lifecycle + tests`, public surface only.
- Create, list (keyset), get, patch, settings patch, archive, restore, soft delete.
- A deletion-preview endpoint so the UI can explain consequences without inventing them
  (frontend §81B, backend §102).
- Audit events for create, update, settings change, archive, restore, delete.
- Tenant scoping enforced in the repository layer, never by a route-built filter.

### Out of scope (owner phase)

- `projects.members[]`, effective project permissions, `requireProjectPermission` — **Phase 18**.
- All frontend wiring and badge mapping — **Phase 19**.
- `Job` / `JobEvent` and enqueueing anything — **Phase 20**.
- Upload, source versions, exclusions — **Phases 23, 24**.
- Repository probe, attach, credentials, branch, sync — **Phases 30–32**.
- Writing `knowledgeHealth` from real processing, `KnowledgeVersion` — **Phase 28**.
- Cascade soft-delete of sources/knowledge/conversations and any hard purge — **Phase 60**.
- Maintaining the count fields with real numbers — the phase that owns each number.

## 4. Design

### 4.1 Module layout

```text
src/modules/projects/
  index.ts                  public surface (service + types only)
  projects.routes.ts        HTTP handlers; own `reply`
  projects.service.ts       use cases, audit calls, transition orchestration
  projects.repository.ts    the only file that builds Mongo filters
  projects.model.ts         Mongoose schema + indexes
  projects.lifecycle.ts     state machine (pure functions, no I/O)
  projects.types.ts         DTOs shared with the routes
```

### 4.2 Lifecycle states and transitions

The ten states are taken verbatim from backend §9 and stored as stable snake_case codes. The
UI never invents a state (frontend §9, §98); display strings are Phase 19's mapping table.

```text
creating · awaiting_source · connecting_repository · source_received · processing
knowledge_ready · updating · failed · partially_available · archived
```

| From | Allowed next |
|---|---|
| `creating` | `awaiting_source`, `connecting_repository`, `failed` |
| `awaiting_source` | `source_received`, `connecting_repository`, `failed`, `archived` |
| `connecting_repository` | `source_received`, `awaiting_source`, `failed`, `archived` |
| `source_received` | `processing`, `failed`, `archived` |
| `processing` | `knowledge_ready`, `partially_available`, `failed`, `archived` |
| `knowledge_ready` | `updating`, `failed`, `archived` |
| `updating` | `knowledge_ready`, `partially_available`, `failed`, `archived` |
| `partially_available` | `updating`, `knowledge_ready`, `failed`, `archived` |
| `failed` | `awaiting_source`, `connecting_repository`, `processing`, `updating`, `archived` |
| `archived` | the state recorded in `preArchiveLifecycleStatus` (restore only) |

Everything not in the table is invalid and returns `409 INVALID_STATE_TRANSITION` with the
attempted pair in `details` (backend §153). `transitionLifecycle` is the **only** writer of
`lifecycleStatus`; it takes `{ from, to, source, reasonCode, actorUserId?, knowledgeVersionId? }`,
performs a conditional update on `{ _id, orgId, status: 'A', lifecycleStatus: from }`,
and treats a zero-match result as a lost race → re-read and re-validate once, then fail.

Two extra rules the state table alone cannot express:

- **`source` classification.** Every transition is tagged `api` or `worker`.
  `knowledge_ready` and `partially_available` require `source: 'worker'` **and** a
  `knowledgeVersionId`; an HTTP handler therefore cannot reach them even by accident
  (backend §111, §112). Phase 28 is the first caller that satisfies the guard.
- **Archive is reversible, delete is not a transition.** Archive stores
  `preArchiveLifecycleStatus` and sets `archivedAt`; restore reads it back. Soft delete sets row
  `status: 'D'` and leaves `lifecycleStatus` untouched so processing history stays explainable.

### 4.3 `knowledgeHealth` is a different field

Backend §85 requires knowing whether knowledge is current, updating, stale, partial, failed or
ready. That is orthogonal to the lifecycle: an `updating` project still has last-published
knowledge. `knowledgeHealth` therefore lives in its own field, starts as `none`, and is only
written by the publish path in Phase 28. Phase 17 defines the enum, the default, and the
invariant that `knowledgeHealth: 'ready'` is impossible while `lifecycleStatus` is
`creating | awaiting_source | connecting_repository | source_received`.

### 4.4 Creation — one entry point, two paths

Backend §9 says both upload and repository connection start as a project creation. The handler
therefore always inserts at `creating` and immediately transitions:

```text
POST /projects { sourceType: 'upload' }      → creating → awaiting_source
POST /projects { sourceType: 'repository' }  → creating → connecting_repository
```

No source work happens in the handler (the boundary rule in `AGENTS.md`): the upload
(Phase 24) or repository attach (Phase 31) call is a separate request made by the client after
creation. `Idempotency-Key` is honoured through Phase 12, so a double-submitted create returns
the first project instead of two rows (solution §13.2).

### 4.5 Counts are reported, never estimated

`counts.{sourceVersions, files, excludedFiles, conversations}` default to `0` and are written
**only** by the phase that owns the underlying rows (24, 28, 41). Phase 17 never derives,
interpolates or back-fills them, per the "no fabricated metrics" rule in README §4.

### 4.6 Deletion consequences

Frontend §81B requires the UI to explain what happens to source, knowledge, conversations,
processing history and audit records before a delete is confirmed. So the backend returns those
facts instead of letting the UI hardcode them: `GET /projects/:projectId/deletion-preview`
reports the current counts plus the retention statement for each class of data as the backend
defines it. The delete itself only soft-deletes the project row and records the intent; the
cascade is Phase 60 (solution §12.3) and audit rows always survive (solution §9.1).

### 4.7 Tenant scoping and pagination

Every repository function takes `orgId` as its first argument and injects
`{ orgId, status: 'A' }` into the filter. Routes pass the org id resolved from the JWT
by Phase 07 — a body or query `orgId` is stripped by the request schema. List uses
keyset pagination on `(updatedAt, _id)` with an opaque base64 cursor; archived projects are
excluded unless `includeArchived=true` (frontend §81B).

## 5. Data model changes

New collection `projects`.

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | Tenant key, required |
| `name` | string | 1–120 chars, trimmed |
| `description` | string | optional, ≤ 2000 chars |
| `lifecycleStatus` | enum (10 values above) | default `creating` |
| `preArchiveLifecycleStatus` | enum \| null | set on archive, cleared on restore |
| `lifecycleStatusReasonCode` | string \| null | stable code, never a raw driver message |
| `lifecycleStatusChangedAt` | Date (UTC) | |
| `knowledgeHealth` | `none\|updating\|ready\|partial\|stale\|failed` | default `none` |
| `currentKnowledgeVersionId` | ObjectId \| null | written by Phase 28 |
| `sourceConfig` | `{ sourceType: 'upload'\|'repository', repositoryConnectionId?, currentSourceVersionId? }` | reference only; populated by Phases 24/31 |
| `settings` | object | validated against a key registry (§4 and open question 2) |
| `counts` | `{ sourceVersions, files, excludedFiles, conversations }` | default `0` |
| `createdBy` | ObjectId | |
| `archivedAt` / `createdAt` / `updatedAt` | Date (UTC) | |
| `status` | `'A' \| 'D'` | default `'A'` (README §4) |

Indexes:

- `{ orgId: 1, updatedAt: -1, _id: -1 }` partial `status: 'A'` — list keyset path.
- `{ orgId: 1, lifecycleStatus: 1 }` partial `status: 'A'` — dashboard grouping.
- `{ orgId: 1, name: 1 }` unique, partial `status: 'A'` — see open question 1.

Declared on the `Project` Mongoose schema; synced via Phase 03 `syncSchemaIndexes`, not
`autoIndex` in production.

## 6. API contract — PROPOSED (needs approval before implementation)

All paths under `/api/v1`. All errors use `{ error: { code, message, details? } }`.
Permission names come from solution §8.2.

### `POST /projects` — `projects.create`

```json
{ "name": "Atlas Commerce", "description": "Checkout and payments", "sourceType": "repository" }
```

`201`:

```json
{
  "id": "6650f1a2c3d4e5f601020304",
  "name": "Atlas Commerce",
  "description": "Checkout and payments",
  "lifecycleStatus": "connecting_repository",
  "knowledgeHealth": "none",
  "sourceConfig": { "sourceType": "repository" },
  "counts": { "sourceVersions": 0, "files": 0, "excludedFiles": 0, "conversations": 0 },
  "createdBy": "6650f0aa0000000000000001",
  "createdAt": "2026-09-11T09:12:04.000Z",
  "updatedAt": "2026-09-11T09:12:04.000Z"
}
```

Errors: `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`,
`409 PROJECT_NAME_TAKEN`, `429 RATE_LIMITED`.

### `GET /projects?limit=20&cursor=…&q=atlas&includeArchived=false` — `projects.view`

```json
{
  "items": [
    {
      "id": "6650f1a2c3d4e5f601020304",
      "name": "Atlas Commerce",
      "description": "Checkout and payments",
      "lifecycleStatus": "knowledge_ready",
      "knowledgeHealth": "ready",
      "sourceConfig": { "sourceType": "repository" },
      "counts": { "sourceVersions": 3, "files": 4812, "excludedFiles": 9, "conversations": 12 },
      "updatedAt": "2026-09-11T09:40:00.000Z"
    }
  ],
  "nextCursor": "eyJ1cGRhdGVkQXQiOiIyMDI2LTA5LTExVDA5OjQwOjAwWiJ9"
}
```

`nextCursor` is `null` on the last page.

### `GET /projects/:projectId` — `projects.view`

Returns the create-response shape plus `archivedAt` and `currentKnowledgeVersionId`.
`404 PROJECT_NOT_FOUND` when the project belongs to another organization or `status = 'D'`.

### `PATCH /projects/:projectId` — `projects.update`

```json
{ "name": "Atlas Commerce Platform", "description": "Checkout, payments and refunds" }
```

Only `name` and `description` are accepted. Any attempt to send `lifecycleStatus`,
`knowledgeHealth`, `counts`, `orgId` or `status` → `400 VALIDATION_ERROR` naming the
rejected field. `200` returns the updated project.

### `GET /projects/:projectId/settings` · `PATCH /projects/:projectId/settings` — `settings.manage`

```json
{ "settings": {} }
```

Solution §8.4 defines the endpoint but names no keys, so Phase 17 ships the container, the
RBAC check, the audit event and a **key registry that starts empty**: an unknown key is
rejected with `400 UNKNOWN_SETTING`. Later phases register their own keys (see open question 2).

### `POST /projects/:projectId/archive` · `POST /projects/:projectId/restore` — `projects.update`

`200` with the updated project. Archive from `archived` → `409 INVALID_STATE_TRANSITION`.
Restore returns the project to `preArchiveLifecycleStatus`.

### `GET /projects/:projectId/deletion-preview` — `projects.delete`

```json
{
  "counts": { "sourceVersions": 3, "files": 4812, "conversations": 12, "jobs": 9 },
  "consequences": [
    { "resource": "source", "effect": "soft_deleted", "retentionDays": null },
    { "resource": "knowledge", "effect": "soft_deleted", "retentionDays": null },
    { "resource": "conversations", "effect": "soft_deleted", "retentionDays": 365 },
    { "resource": "processing_history", "effect": "soft_deleted", "retentionDays": 180 },
    { "resource": "audit_events", "effect": "retained", "retentionDays": 730 }
  ]
}
```

Defaults mirror solution §12.3; the UI renders these facts and never hardcodes them.

### `DELETE /projects/:projectId` — `projects.delete`

`204`, no body. Sets row `status: 'D'`. Repeating it returns `404 PROJECT_NOT_FOUND`.

## 7. Configuration & environment variables

**None.** No new `.env` keys. List page sizes are named constants
(`.cursor/rules/env-config.mdc`).

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `PROJECTS_LIST_DEFAULT_LIMIT` | `20` | `modules/projects/projects.repository.js` | Page size when `limit` is absent |
| `PROJECTS_LIST_MAX_LIMIT` | `100` | `modules/projects/projects.repository.js` | Upper bound for `limit` |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/projects/projects.model.js` | **New:** schema, enums, indexes |
| `backend/src/modules/projects/projects.lifecycle.js` | **New:** transition table + guards |
| `backend/src/modules/projects/projects.lifecycle.test.js` | **New:** full valid/invalid matrix |
| `backend/src/modules/projects/projects.repository.js` | **New:** org-scoped queries, keyset list |
| `backend/src/modules/projects/projects.repository.test.js` | **New:** scoping, pagination, soft delete |
| `backend/src/modules/projects/projects.service.js` | **New:** use cases, audit, idempotency |
| `backend/src/modules/projects/projects.service.test.js` | **New:** service behaviour and failures |
| `backend/src/modules/projects/projects.routes.js` | **New:** handlers, request schemas |
| `backend/src/modules/projects/projects.routes.test.js` | **New:** integration via `app.inject` |
| `backend/src/modules/projects/projects.types.js` | **New:** DTOs |
| `backend/src/modules/projects/index.js` | **New:** public surface |
| `backend/src/http/routes.js` | Register `projectRoutes` |
| `backend/src/http/routes.test.js` | Assert the new routes are mounted |

## 9. Tests (≥ 80% line and branch)

### Unit

- Every allowed transition in the §4.2 table succeeds.
- A representative invalid transition from **each** state is rejected with
  `INVALID_STATE_TRANSITION`.
- `knowledge_ready` and `partially_available` are rejected when `source: 'api'`.
- `knowledge_ready` is rejected when `knowledgeVersionId` is missing.
- Archive stores `preArchiveLifecycleStatus`; restore returns to it; archiving twice fails.
- `knowledgeHealth: 'ready'` is rejected while lifecycle is pre-processing.
- Cursor encode/decode round-trips; a malformed cursor yields `400 INVALID_CURSOR`.
- Counts are never written by any function in this module.

### Integration (Fastify `app.inject` against the Phase 03 test database)

- `POST /projects` with `sourceType: 'upload'` lands in `awaiting_source`; `repository` lands
  in `connecting_repository`.
- The create response is echoed for a repeated `Idempotency-Key` and only one row exists.
- `GET /projects` paginates deterministically across three pages and excludes archived rows.
- `includeArchived=true` returns archived rows; `status: 'D'` rows are never returned.
- `PATCH` with `lifecycleStatus` in the body returns `400` naming the field.
- `PATCH /settings` with an unknown key returns `400 UNKNOWN_SETTING`.
- `GET /deletion-preview` returns the counts actually stored on the project.
- `DELETE` then `GET` returns `404`; the audit row for the delete still exists.
- `AuditEvent` rows exist for create, update, settings change, archive, restore, delete, with
  actor, action, resource id and result.

### Unhappy paths that must be covered

- A user of organization A reading, patching, archiving or deleting a project of organization B
  gets `404`, not `403` — existence must not leak (backend §89, §114).
- A caller missing `projects.create` / `projects.update` / `projects.delete` gets `403`.
- An unauthenticated request gets `401` on every route.
- `orgId` supplied in the body or query is ignored, and the row keeps the JWT's org.
- A concurrent double transition leaves exactly one winner and one `409`.
- Duplicate active name in the same org → `409 PROJECT_NAME_TAKEN`; the same name in another
  org succeeds.

## 10. Definition of Done

- [ ] The ten lifecycle states match backend §9 exactly — no extra, no missing, no renamed.
- [ ] `lifecycleStatus` is written only by `transitionLifecycle`; no route or repository
      function assigns it directly.
- [ ] No HTTP route can produce `knowledge_ready` or `partially_available`.
- [ ] `knowledgeHealth` is a separate field and is still `none` after this phase's flows.
- [ ] Every repository function takes `orgId` and injects `status: 'A'`.
- [ ] List, get, patch, settings, archive, restore, delete, deletion-preview all exist under
      `/api/v1` with the permissions in section 6.
- [ ] Delete is soft (`status: 'D'`); no `deleteOne`/`deleteMany` exists in the module.
- [ ] Audit events are written for create, update, settings change, archive, restore, delete.
- [ ] Counts are never computed or guessed in this module.
- [ ] Keyset pagination works with a stable order and an opaque cursor.
- [ ] `npm run lint` and `npm test` pass in `backend/`, with ≥ 80% line
      and branch coverage on every file this phase touched.
- [ ] The `Project` schema declares all three indexes; synced via `syncSchemaIndexes`; no
      `autoIndex` reliance in production.

## 11. Documentation & ADR updates

- `docs/architecture.md` §3: the `projects` bullet now describes a real collection — align the
  field names with section 5 if they differ.
- Add the lifecycle table to `docs/data-model.md` if that document exists by then; otherwise
  section 5 of this phase is the reference until Phase 20 creates it.
- No new ADR is expected: MongoDB and Mongoose are decided in Phase 04. Write one if the
  settings-registry approach (open question 2) is adopted as a general pattern.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Project name uniqueness.** Proposed: unique per organization among active rows. Should a
   soft-deleted project free its name, and is a duplicate name allowed at all?
2. **`settings` keys.** Solution §8.4 exposes `GET/PATCH /projects/:id/settings` but names no
   fields. Which keys exist in the MVP, and which phase owns each one? Until answered, the
   registry is empty and `PATCH` only rejects.
3. **`knowledgeHealth` vocabulary.** Backend §85 lists Current, Updating, Stale, Partial,
   Failed, Ready — "Current" and "Ready" look like the same state, while frontend §8 shows
   "Needs attention" and "Outdated". Confirm the canonical backend enum before Phase 19 builds
   its mapping table.
4. **Restore after failure.** If a project is archived while `failed`, restore returns it to
   `failed`. Is that the wanted behaviour, or should restore land on `awaiting_source`?
5. **Archive and running work.** Archiving a project that has a running ingest job — reject
   with `409`, cancel the job (Phase 22), or let it finish? Phase 20/21 need the answer.
6. **Deletion-preview retention numbers.** The values in section 6 are solution §12.3 defaults.
   Should they be read from a per-organization retention policy (Phase 60) instead of a
   constant, and should this endpoint wait for that phase?
7. **`lifecycleStatusReasonCode` catalog.** Should these codes come from the Phase 02 error-code
   catalog, or is a separate lifecycle-reason catalog wanted?
