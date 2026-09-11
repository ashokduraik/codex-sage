# Phase 20 — Job & JobEvent models with job read APIs

- **Layer:** BE
- **Depends on:** Phase 03 (base schema, index sync, test harness), Phase 17 (project +
  `orgId` / `projectId` scope)
- **Unblocks:** Phase 21 (claim loop), Phase 22 (retry/cancel/progress), Phase 24 (enqueue
  `pending` ingest jobs)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §31–§35, §95, §97, §154;
  `backend/solution.md` §7, §4.6; `docs/architecture.md` §2, §5; frontend §20–§21 (read
  shape only)

## 1. Goal

After this phase MongoDB holds **`jobs` and `jobEvents`**, with a schema complete enough that
Phases 21–25 **do not add worker or checkpoint fields**. Read APIs list and fetch a job the UI
will later bind to: identity, `jobStatus`, `jobType`, current stage, checkpoint, counters,
failure class, timestamps. Nothing claims or runs a job.

You can see it working by inserting a `pending` ingest job in a test (or a later upload) and
calling `GET /api/v1/projects/:projectId/jobs` — the row appears with `jobStatus: "pending"`
and an empty event list — then `GET /api/v1/jobs/:jobId` returns the same document plus
events. A second organization's token receives `404`.

## 2. Why this phase is here

The worker (21) cannot claim a document that does not exist; ingest (24/25) cannot enqueue one
either. Progress and retry (22) need a stable read model. Putting *all* runtime fields on `Job`
now prevents the "add if 20 didn't define it" drift that Phase 21/25 previously risked.

It cannot come before Phase 17: jobs are project-scoped. It cannot come after 21: the claim
loop would invent its own schema.

## 3. Scope

### In scope

- `Job` and `JobEvent` Mongoose models, indexes, repositories (tenant + project scoped).
- **Worker-ready fields** on `Job` (written later by 21, 22, 25): `workerId`, `attempt`,
  `maxAttempts`, `heartbeatAt`, `leaseExpiresAt`, `scheduledAt`, `failureClass`,
  `currentStage`, `stageCheckpoint`, `progressCounters`, `cancelRequestedAt`,
  `correlationId`.
- Read APIs: list by project, get by id (with events).
- Enqueue helper used by Phase 24: `createPendingJob({ ... })` returns ids; no HTTP create
  for clients in this phase.
- Migration creating collections and indexes.

### Out of scope (owner phase)

- Claim, heartbeat, lease sweeper, handler registry — **Phase 21**.
- Retry, cancel, derived `progress` projection — **Phase 22** (adds retry metadata; may
  extend the GET body with `progress`).
- Writing ingest stage events in user language — **Phase 25**.
- Notifications on completion — **Phase 58**.
- SSE of job progress — **Phase 35 / 50** as applicable.

## 4. Design

### 4.1 Module layout

`backend/src/modules/jobs/` (`routes + service + repository + tests`, public `index.js`).
Other modules import `createPendingJob` and `getJobById` from the surface, never the model.

### 4.2 Job status vs row status

| Field | Values | Meaning |
|---|---|---|
| `status` | `'A' \| 'D'` | Row visibility. Failed jobs stay `'A'` (backend §36). |
| `jobStatus` | `pending \| running \| completed \| completed_with_warnings \| failed \| retrying \| cancelled` | Lifecycle (solution §7) |

List/detail default `status: 'A'`. Soft-delete of a job is not a product action in this
slice; do not expose DELETE.

### 4.3 Canonical checkpoint

One shape, used by 21 and 25:

```text
stageCheckpoint: {
  lastCompletedStage: string | null,  // e.g. 'exclude_apply'
  cursor?: unknown,                   // stage-defined; opaque to the loop
  updatedAt: Date | null              // UTC
}
```

There is **no** `checkpoint.completedStages[]`. Resume means "run the next stage after
`lastCompletedStage`". `currentStage` is the stage now executing (or last attempted).

### 4.4 Progress counters on the document

Stored so a GET does not have to scan every event:

```text
progressCounters: {
  itemsProcessed: number,  // default 0
  itemsFailed: number,
  warningCount: number,
  excludedCount: number
}
partialSuccess: boolean    // default false
```

Phase 22 may add a derived `progress.stages[]` block; it must not invent a second counter
store.

### 4.5 JobEvent

Append-only. Soft-delete is unused except purge-by-ADR later. Each event:

- `eventCode` (stable, e.g. `job.enqueued`)
- `severity`: `info | warning | error`
- `message`: human-readable, no ids/stacks/bytes (frontend §21, §26)
- `data`: structured, allowlisted keys (paths, counts, codes)
- `createdAt` UTC
- `correlationId` copied from the job when present

This phase writes `job.enqueued` from `createPendingJob`. The worker loop (21) writes claim /
requeue / fail codes.

### 4.6 Read authorization

List and get require a project-scoped view permission. **Proposed:** `projects.view` plus
membership (Phase 18). Until 18 exists, Phase 17's project access (creator-only / org admin)
is the gate — same as other project reads. Cross-tenant ids return `404`, not `403`.

## 5. Data model changes

### `jobs`

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | required |
| `projectId` | ObjectId | required |
| `jobType` | string | `'ingest' \| 'reingest' \| 'repo_sync' \| …`; ingest used first |
| `jobStatus` | enum | see §4.2 |
| `sourceVersionId` | ObjectId \| null | set by Phase 24 |
| `createdBy` | ObjectId \| null | |
| `correlationId` | string \| null | Phase 02 request id when enqueued from HTTP |
| `workerId` | string \| null | Phase 21 |
| `attempt` | number | default 0 |
| `maxAttempts` | number | default from worker constant, copied at create |
| `heartbeatAt` | Date \| null | |
| `leaseExpiresAt` | Date \| null | |
| `scheduledAt` | Date | default now (UTC); claim filter |
| `failureClass` | `'temporary' \| 'permanent' \| 'user_action_required'` \| null | |
| `failureCode` | string \| null | stable code |
| `currentStage` | string \| null | |
| `stageCheckpoint` | object \| null | §4.3 |
| `progressCounters` | object | §4.4 |
| `partialSuccess` | boolean | default false |
| `cancelRequestedAt` | Date \| null | Phase 22 sets; 21 reads |
| `startedAt` / `completedAt` | Date \| null | |
| `status` | `'A' \| 'D'` | default `'A'` |
| `createdAt` / `updatedAt` | Date | UTC |

Indexes (partial `status: 'A'` where listed):

- `{ orgId, projectId, createdAt: -1, _id: -1 }` — list keyset
- `{ orgId, projectId, jobStatus }` — dashboard
- `{ status, jobStatus, jobType, scheduledAt }` — claim (Phase 21)
- `{ status, jobStatus, leaseExpiresAt }` — sweep (Phase 21)

### `jobEvents`

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | required |
| `projectId` | ObjectId | required |
| `jobId` | ObjectId | required |
| `eventCode` | string | |
| `severity` | `'info' \| 'warning' \| 'error'` | |
| `message` | string | user language |
| `data` | object | allowlisted |
| `correlationId` | string \| null | |
| `status` | `'A' \| 'D'` | default `'A'` |
| `createdAt` | Date | UTC; no updates in practice |

Index: `{ orgId, jobId, createdAt: 1 }` partial `status: 'A'`.

## 6. API contract — PROPOSED (needs approval before implementation)

All under `/api/v1`. Errors: existing envelope. Rate class: `search` for reads (list polling).
No `Idempotency-Key` on GET.

### `GET /projects/:projectId/jobs?cursor&limit&jobStatus`

Permission: `projects.view` (plus membership when Phase 18 exists).

Response `200`:

```json
{
  "items": [{
    "id": "665f1c9d4b2a8e0012a4f001",
    "jobType": "ingest",
    "jobStatus": "pending",
    "currentStage": null,
    "failureClass": null,
    "partialSuccess": false,
    "progressCounters": {
      "itemsProcessed": 0,
      "itemsFailed": 0,
      "warningCount": 0,
      "excludedCount": 0
    },
    "scheduledAt": "2026-09-11T10:40:00.000Z",
    "createdAt": "2026-09-11T10:40:00.000Z",
    "startedAt": null,
    "completedAt": null
  }],
  "pageInfo": { "nextCursor": null, "hasMore": false }
}
```

### `GET /jobs/:jobId`

Same permission, project resolved from the job. Response `200`: the list item plus:

```json
{
  "projectId": "6651bb2c4b2a8e0012a4e002",
  "sourceVersionId": null,
  "stageCheckpoint": null,
  "correlationId": "req_01J9ZK4T2M",
  "events": [{
    "eventCode": "job.enqueued",
    "severity": "info",
    "message": "Processing is queued.",
    "data": {},
    "createdAt": "2026-09-11T10:40:00.000Z"
  }]
}
```

Do **not** return `workerId` to the client (operational, not user-facing). Do not fabricate
`percent`.

Errors: `401`, `403`, `404 JOB_NOT_FOUND`, `400 INVALID_CURSOR`.

Internal: `createPendingJob` — no HTTP.

## 7. Configuration & environment variables

**None.** List page size is a constant.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `JOB_LIST_PAGE_SIZE_DEFAULT` | `20` | `modules/jobs/jobs.constants.js` | Default `limit` |
| `JOB_LIST_PAGE_SIZE_MAX` | `100` | same | Clamp |
| `JOB_EVENT_MESSAGE_MAX_LENGTH` | `500` | same | Cap stored message |

`maxAttempts` default is copied from Phase 21's `WORKER_MAX_ATTEMPTS` when 21 exists; until
then this phase uses a local constant `JOB_DEFAULT_MAX_ATTEMPTS = 5` **or** duplicates the
same number — implementers must not introduce an env var. Proposed: define
`JOB_DEFAULT_MAX_ATTEMPTS` here and have 21 import it.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/jobs/job.model.js` | **New** |
| `backend/src/modules/jobs/jobEvent.model.js` | **New** |
| `backend/src/modules/jobs/jobs.repository.js` | **New** |
| `backend/src/modules/jobs/jobs.service.js` | **New:** createPending + reads |
| `backend/src/modules/jobs/jobs.routes.js` | **New:** GET list + detail |
| `backend/src/modules/jobs/jobs.constants.js` | **New** |
| `backend/src/modules/jobs/index.js` | **New:** public surface |
| colocated `*.test.js` | **New** |
| `backend/src/http/routes.js` | Register job routes |

## 9. Tests (≥ 80% line and branch)

### Unit

- `createPendingJob` writes `jobStatus: 'pending'`, `scheduledAt` now, `stageCheckpoint: null`,
  one `job.enqueued` event.
- Mapper omits `workerId`, hashes, and any secret.
- Cursor encode/decode via Phase 03 helper.

### Integration

- List is tenant- and project-scoped; org B's job never appears.
- Get by id across orgs → `404`.
- `status: 'D'` jobs are absent from list/detail.
- Failed jobs (`jobStatus: 'failed'`, `status: 'A'`) **are** returned (backend §36).
- Pagination: no duplicates, `hasMore` false on last page.
- `limit` clamped; `limit=0` → `400`.

### Unhappy paths

- Unknown `jobStatus` filter → `400`.
- Event `message` over the max length is rejected at write, not truncated into a lying UI string.

## 10. Definition of Done

- [ ] `Job` includes every field in §5 so Phases 21 and 25 add **no** overlapping schema churn.
- [ ] Checkpoint field is `stageCheckpoint` with `lastCompletedStage` / `cursor` / `updatedAt`.
- [ ] Read APIs exist; no claim loop; no client job-create HTTP.
- [ ] Failed jobs remain readable.
- [ ] Cross-tenant access is `404`.
- [ ] No new `.env` keys.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/data-model.md`: `jobs`, `jobEvents`, checkpoint shape.
- `docs/architecture.md` §5: jobs live in Mongo; worker claims later (21).
- No new ADR (jobs-without-Redis is Phase 04 ADR 0004).

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **List path.** Nested `GET /projects/:projectId/jobs` vs flat `GET /jobs?projectId=`.
   Proposal: nested for list, flat for detail (as above). Confirm — Phase 35 builds URLs.
2. **Permission.** `projects.view` vs `knowledge.trigger` vs a new `jobs.view`. Proposal:
   `projects.view` for read; trigger stays on mutate in Phase 22.
3. **Expose `stageCheckpoint` on GET?** Useful for support; noisy for the UI. Proposal:
   include on detail, omit on list.
4. **`retrying` in this phase's enum** even though only Phase 22 writes it. Proposal: yes,
   so the schema is complete.
5. **Progress block.** Phase 22 proposes adding `progress` to this GET. Confirm there will
   be no separate `/progress` URL.
