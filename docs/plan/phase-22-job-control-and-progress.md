# Phase 22 — Job control: retry, cancel & human-readable progress

- **Layer:** BE
- **Depends on:** Phase 21 (worker runtime, checkpoints, failure classes), Phase 12
  (`Idempotency-Key` on retry)
- **Unblocks:** Phase 29, 35, 58 (re-ingest, the processing center UI, notifications)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §33 (job progress), §34 (understandable
  activity events), §35 (processing history), §36 (failed processing is preserved), §37 (retry
  only the failed portion; no duplicate processing), §38 (partial success), §92 (idempotency),
  §109 (retry strategy), §153 (valid state transitions), §154 (structured state for the UI);
  `frontend/requirments.md` §21 (activity log), §23 (processing center), §25 (understandable
  errors), §26 (error details), §27 (retry); `backend/solution.md` §4.6 (failure rules), §4.7
  (retry vs reingest vs re-upload), §13.2 (idempotency)

## 1. Goal

After this phase a user (through the API, until Phase 35 builds the UI) can retry a failed job
and cancel a running one, and can read a progress payload that describes a job the way a person
would: an ordered list of stages with completed, current and pending entries, counts of items
processed, warnings, errors, start and completion times, and whether retry is available and in
which mode.

You can see it working by failing a test job in the worker, calling
`POST /api/v1/jobs/:jobId/retry`, and watching the same job resume at its checkpoint instead of
restarting; by clicking retry twice with the same `Idempotency-Key` and getting the same job id
back both times; and by cancelling a running job and seeing it stop at the next stage boundary.

## 2. Why this phase is here

Phase 21 can run and requeue jobs but only the worker decides when. Requirements §37 and
frontend §27 make retry a user-facing capability, and §36 makes the *inspectability* of a failure
a product guarantee, so the control surface has to exist before ingest starts producing real
failures in Phase 25.

It cannot come earlier: retry semantics are meaningless without checkpoints and failure classes
(Phase 21), and cancellation needs the cooperative cancel check the runtime already exposes. It
must come before the frontend processing center (Phase 35), which renders exactly the payload
defined here, and before Phase 29, which adds the second control verb (`reingest`) on top of the
same state machine.

## 3. Scope

### In scope

- `POST /api/v1/jobs/:jobId/retry` with permission checks, state-transition validation and
  `Idempotency-Key` handling.
- `POST /api/v1/jobs/:jobId/cancel` with cooperative cancellation for `running` jobs and
  immediate cancellation for `pending` ones.
- Retry mode resolution: resume from the stage checkpoint, full re-run, or not retryable, with
  the reason attached so the UI can explain it (frontend §27).
- The progress projection the UI renders: ordered stage list, counts, warnings, errors,
  timestamps, retry availability.
- The human-readable event vocabulary: a catalogue mapping event codes to user-facing messages,
  plus the rule that internal ids and raw logs are never the primary experience.
- The job state machine with invalid transitions rejected (backend §153).
- Audit events for retry and cancel (solution §9.2, knowledge category).
- Guarantee that a failed or cancelled job is never removed and stays readable.

### Out of scope (owner phase)

- Stage implementations that produce the events and counts — **Phases 25, 26, 27, 28**.
- `POST /sources/:sourceVersionId/reingest` and source diffing — **Phase 29**.
- `POST /repositories/sync` — **Phase 32**.
- Notifications when a job finishes or needs attention — **Phase 58**.
- Job list and job detail read endpoints — **Phase 20** (this phase extends the detail payload).
- Processing-center UI, i18n strings, persistent status indicator — **Phase 35**.
- Rate-limit budgets and the `Idempotency-Key` middleware itself — **Phase 12**.

## 4. Design

### 4.1 Job state machine

The service is the only place allowed to change `jobStatus`, and it validates every transition
(backend §153):

```text
pending   → running | cancelled
running   → completed | completed_with_warnings | failed | cancelled | pending (requeue)
failed    → retrying
retrying  → pending
cancelled → retrying
completed | completed_with_warnings → (terminal)
```

`retrying` is the short-lived state a control call writes before the job becomes claimable again;
it makes "the user asked for a retry" visible even before the worker picks the job up
(backend §32 lists it as a state; §153 shows it in the example cycle). Any other transition is
rejected with `409 INVALID_JOB_TRANSITION` and the current status in `details`, never silently
ignored. `status: 'A' | 'D'` is untouched by control calls: cancelling is a lifecycle change, not
a delete.

### 4.2 Retry: resume where possible

Retry resolves a **mode** from the stored failure, never from client input:

| Failure position / class | Mode | Why |
|---|---|---|
| Failed at a resumable stage with a valid checkpoint | `resume` | Re-run only the failed stage onward (backend §37, frontend §27) |
| Failed at `validate_upload` or `store_files` with `user_action_required` | `not_retryable` | The bytes are wrong; the fix is a new upload (solution §4.6 S0 row) |
| Failure class `permanent` on a stage that cannot be partially redone | `full` | Whole job re-runs; the reason is returned so the UI can explain it |
| Graph stage failed and the workspace may be half-updated | `full` | The graph must be rebuilt from the last accepted tree (solution §4.8 failure paragraph) |

A `resume` retry keeps the same `Job`, the same `sourceVersionId` and the same checkpoint, resets
`jobStatus` to `pending` via `retrying`, sets `scheduledAt = now`, resets `attempt` to zero for
the new user-initiated cycle, and appends a `job.retry_requested` event naming the stage it will
resume from. A `full` retry clears the checkpoint and `currentStage` first. Neither creates a new
`Job` document, so processing history stays a single thread per source version (backend §35), and
`reingest` — which *does* create a new job on the same bytes — remains Phase 29's distinct verb
(solution §4.7).

Retry mode is also exposed read-only on the job payload as `retry.mode` and `retry.reason` so the
UI can label the button before the user presses it, rather than discovering the answer from an
error.

### 4.3 No second writer on a duplicate click

Three layers protect against duplicate processing (backend §37, §92):

1. **Idempotency.** Phase 12's middleware stores `{ key, orgId, userId, route }` and replays the
   first response. A double click with the same key returns the identical body.
2. **Active-job check.** Without a key — or with a different key — the service looks for an
   active job (`pending`, `retrying`, `running`) for the same project and returns **that** job
   with `200` and `alreadyActive: true` instead of starting a second one (solution §4.7 last
   line).
3. **Per-project lock.** Even if two control calls slip through, Phase 21's project lock means
   only one writer ever executes.

The same three layers apply to cancel: cancelling an already-cancelled job returns the current
state with `200`, not an error.

### 4.4 Cancel

`pending` and `retrying` jobs are cancelled directly by the control call: one conditional update
to `cancelled`, a `job.cancelled` event, and nothing else to clean up.

A `running` job is *requested* to cancel: the call sets `cancelRequestedAt` and
`cancelRequestedBy` and returns `202` with `jobStatus: 'running'` and
`cancellation: { requested: true }`. The worker's `isCancelRequested()` check (Phase 21) is
consulted at stage boundaries only, so a stage that is mid-way through a graph write finishes or
fails cleanly rather than leaving a half-written index. The handler then transitions to
`cancelled`, releases the project lock, and writes the event. Cancellation is therefore
best-effort and the response must say so — never report a running job as cancelled before the
worker confirms it (backend §152).

### 4.5 Progress projection

The progress block is derived, never stored twice. It is computed from the job document plus its
`JobEvent` lines and returned inside the Phase 20 job detail response (see §12 question 1):

- `stages[]` — the ordered stage list for the job type, each with
  `state: 'completed' | 'current' | 'pending' | 'failed' | 'skipped'`, `startedAt`, `endedAt`,
  `itemsProcessed`, `itemsFailed`, `warningCount`.
- `itemsProcessed` / `itemsFailed` totals, so the UI can write "4,812 files processed
  successfully, 9 files failed" (backend §38, frontend §25).
- `percent` — **only** when a stage reports a real total; otherwise `null`, and the UI falls back
  to stage-based progress. Never interpolate a number (backend §33: do not fabricate progress).
- `startedAt`, `completedAt`, `durationMs` (all UTC).
- `warnings[]` and `errors[]` as `{ code, message, affectedCount, occurredAt }`.
- `retry: { available, mode, reason }` and `cancellation: { requested, requestedAt }`.
- `knowledgeAvailability` — whether asking questions is paused, queued or available, copied from
  the authoritative project/knowledge state rather than inferred (frontend §26 forbids claiming
  the old knowledge is still usable during or after a failed graph update).

The stage list for a job type comes from one shared definition so the worker, the projection and
the tests cannot drift apart. `ingest` is `validate_upload`, `store_files`, `exclude_apply`,
`materialize_docs`, `codegraph_update`, `knowledge_publish`, `finalize` (solution §4.6). Stage
*implementations* are Phases 25–28; this phase only fixes the list and the labels.

### 4.6 Event vocabulary

Each `JobEvent` carries a stable `eventCode` plus a human-readable `message` (backend §34,
frontend §21). The catalogue lives in one module so every stage uses the same phrasing:

```text
source.received            "Source received"
source.exclusions_applied  "Exclusions applied (1,203 paths skipped)"
files.identified           "Project files identified"
docs.analyzed              "Documentation analyzed"
structure.analyzed         "Project structure analyzed"
knowledge.updated          "Project knowledge updated"
job.retry_requested        "Retry requested; resuming from documentation indexing"
job.cancelled              "Processing cancelled"
```

Rules: the message never contains an object id, a file-system path outside the project tree, a
stack trace, a credential, or a raw driver error. Diagnostics stay in `context` and in the
correlation id, which the UI shows only on serious failures (frontend §25). The catalogue keys
are stable strings so Phase 35 can localise them; the backend also returns a rendered English
`message` so an API consumer without the catalogue is not stuck.

### 4.7 Failures are preserved

A failed job is never deleted and never soft-deleted by a control call (backend §36, solution
§4.6 hard rule 1). Its events, `failureClass`, error codes, checkpoint and timestamps stay
readable until the retention job of Phase 60 soft-deletes processing history at its configured
age. Retry does not overwrite the previous failure narrative: the failure events remain and the
retry appends new ones, which is what frontend §28 renders as processing history.

## 5. Data model changes

No new collection. Phase 20 already owns `cancelRequestedAt` and the checkpoint/progress
fields. This phase adds only user-initiated retry metadata:

| Field | Type | Purpose |
|---|---|---|
| `cancelRequestedBy` | ObjectId \| null | Actor for audit and display (cancel path) |
| `retryRequestedAt` | Date \| null | Last user-initiated retry |
| `retryRequestedBy` | ObjectId \| null | Actor |
| `retryCount` | number | User-initiated retries, distinct from `attempt` |
| `lastRetryMode` | `'resume' \| 'full'` \| null | What the last retry did |

`JobEvent` already has `eventCode` and `severity` from Phase 20. This phase only extends the
human-readable catalogue. Index `{ organizationId: 1, jobId: 1, createdAt: 1 }` on `jobEvents`
filtered to `status: 'A'` if Phase 20 did not already create it.

## 6. API contract — PROPOSED (needs approval before implementation)

### `POST /api/v1/jobs/:jobId/retry`

- **Permission:** `knowledge.trigger` plus project membership on the job's project.
- **Headers:** `Idempotency-Key` recommended (Phase 12). Rate class: admin mutate.
- **Request body:** none.
- **Response `202`:**

```json
{
  "jobId": "665f1c9d4b2a8e0012a4f001",
  "jobStatus": "retrying",
  "retry": { "mode": "resume", "fromStage": "materialize_docs", "reason": null },
  "alreadyActive": false
}
```

- **Response `200`** when an active job already exists (duplicate click, no key or a new key):

```json
{
  "jobId": "665f1c9d4b2a8e0012a4f001",
  "jobStatus": "running",
  "retry": { "mode": "resume", "fromStage": "codegraph_update", "reason": null },
  "alreadyActive": true
}
```

- **Errors:** `400 VALIDATION_ERROR` (malformed id), `401`, `403 FORBIDDEN`,
  `404 JOB_NOT_FOUND` (also used for another tenant's job — never confirm existence),
  `409 INVALID_JOB_TRANSITION`, `409 JOB_NOT_RETRYABLE`:

```json
{
  "error": {
    "code": "JOB_NOT_RETRYABLE",
    "message": "This upload cannot be retried. Remove node_modules and upload the project again.",
    "details": { "failureClass": "user_action_required", "failedStage": "validate_upload" }
  }
}
```

### `POST /api/v1/jobs/:jobId/cancel`

- **Permission:** `knowledge.trigger` plus project membership.
- **Response `202`** for a running job, `200` for a pending or already-cancelled one:

```json
{
  "jobId": "665f1c9d4b2a8e0012a4f001",
  "jobStatus": "running",
  "cancellation": { "requested": true, "requestedAt": "2026-09-11T10:44:01.000Z" }
}
```

- **Errors:** as above, plus `409 INVALID_JOB_TRANSITION` when the job already completed.

### Progress block added to the Phase 20 job detail response — PROPOSED

```json
{
  "jobId": "665f1c9d4b2a8e0012a4f001",
  "jobType": "ingest",
  "jobStatus": "failed",
  "startedAt": "2026-09-11T10:42:00.000Z",
  "completedAt": "2026-09-11T10:47:12.000Z",
  "durationMs": 312000,
  "percent": null,
  "itemsProcessed": 4812,
  "itemsFailed": 9,
  "stages": [
    { "stage": "validate_upload", "label": "Source received", "state": "completed",
      "startedAt": "2026-09-11T10:42:00.000Z", "endedAt": "2026-09-11T10:42:04.000Z",
      "itemsProcessed": 4821, "itemsFailed": 0, "warningCount": 0 },
    { "stage": "materialize_docs", "label": "Documentation analyzed", "state": "failed",
      "startedAt": "2026-09-11T10:44:10.000Z", "endedAt": "2026-09-11T10:47:12.000Z",
      "itemsProcessed": 812, "itemsFailed": 9, "warningCount": 2 },
    { "stage": "codegraph_update", "label": "Project structure analyzed", "state": "pending",
      "startedAt": null, "endedAt": null, "itemsProcessed": 0, "itemsFailed": 0,
      "warningCount": 0 }
  ],
  "warnings": [
    { "code": "FILE_OVER_GRAPH_SIZE_LIMIT", "message": "3 files are too large to analyze.",
      "affectedCount": 3, "occurredAt": "2026-09-11T10:43:02.000Z" }
  ],
  "errors": [
    { "code": "DOCUMENT_PARSE_FAILED", "message": "9 documentation files could not be analyzed.",
      "affectedCount": 9, "occurredAt": "2026-09-11T10:47:12.000Z" }
  ],
  "retry": { "available": true, "mode": "resume", "reason": null },
  "cancellation": { "requested": false, "requestedAt": null },
  "knowledgeAvailability": "paused",
  "correlationId": "req_01J9ZK4T2M"
}
```

## 7. Configuration & environment variables

**None.** No new `.env` keys. Cancel grace and retry ceiling are named constants in the jobs
module (`.cursor/rules/env-config.mdc`). Rate-limit budgets for these routes are configured by
Phase 12, not here.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `JOB_CANCEL_GRACE_MS` | `60000` | `modules/jobs/jobControl.service.js` | How long a cancel request waits for the worker to confirm before the sweeper is allowed to finish the job as `cancelled` |
| `JOB_MAX_USER_RETRIES` | `10` | `modules/jobs/jobControl.service.js` | Ceiling on user-initiated retries per job |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/jobs/jobControl.routes.js` | **New:** retry and cancel routes; the handler owns `reply` |
| `backend/src/modules/jobs/jobControl.routes.test.js` | **New:** status codes, permissions, idempotency replay |
| `backend/src/modules/jobs/jobControl.service.js` | **New:** transition validation, retry mode, cancel, audit |
| `backend/src/modules/jobs/jobControl.service.test.js` | **New:** transition matrix and retry-mode matrix |
| `backend/src/modules/jobs/jobTransitions.js` | **New:** the allowed-transition table and guard |
| `backend/src/modules/jobs/jobTransitions.test.js` | **New:** every allowed and rejected pair |
| `backend/src/modules/jobs/jobStageCatalog.js` | **New:** ordered stage list and labels per job type |
| `backend/src/modules/jobs/jobEventCatalog.js` | **New:** event code → human-readable message |
| `backend/src/modules/jobs/jobEventCatalog.test.js` | **New:** no ids, paths or stack traces in messages |
| `backend/src/modules/jobs/jobProgress.js` | **New:** projection from job + events |
| `backend/src/modules/jobs/jobProgress.test.js` | **New:** stage states, null percent, counters |
| `backend/src/modules/jobs/jobs.repository.js` | **Extend:** conditional control updates, active-job lookup |
| `backend/src/modules/jobs/index.js` | Export the new public surface |
| `backend/src/modules/jobs/jobs.routes.js` | Mount the control routes; include `progress` in detail |
| `backend/src/worker/workerRuntime.js` | **Extend:** honour `cancelRequestedAt` at stage boundaries |

## 9. Tests (≥ 80% line and branch)

### Unit

- Transition guard accepts every pair in §4.1 and rejects the rest, including terminal states.
- Retry mode resolution returns `resume`, `full` and `not_retryable` for each row of §4.2.
- Progress projection marks exactly one stage `current`, orders stages canonically, and leaves
  later stages `pending`.
- `percent` is `null` when no stage reports a total, and a real ratio when one does.
- Counters aggregate `itemsProcessed` / `itemsFailed` across stages (4,812 processed, 9 failed).
- Event catalogue renders every code, and no rendered message contains an ObjectId-shaped
  string, an absolute path, or the word `Error:`.
- Cancel on a `pending` job transitions directly; on a `running` job it only sets the request.

### Integration (`app.inject` + Phase 03 database harness)

- Retry on a failed job returns `202`, sets `retrying`, and the worker then resumes at the
  recorded stage without re-running completed stages.
- Retry twice with the same `Idempotency-Key` returns the identical body and one job.
- Retry twice without a key returns the same job id with `alreadyActive: true` the second time,
  and only one worker run happens.
- Retry on a `user_action_required` failure returns `409 JOB_NOT_RETRYABLE` with the remediation
  message.
- Retry on a completed job returns `409 INVALID_JOB_TRANSITION`.
- Cancel a running job: the worker stops at the next stage boundary, the job becomes `cancelled`,
  and the project lock is released.
- A failed job remains readable after retry: its original failure events are still present.
- Both routes are audit-logged with actor, action, target and result (solution §9.2).
- Job detail includes the progress block with the stage list for its job type.

### Unhappy paths

- Caller without `knowledge.trigger` gets `403`; caller from another organization gets `404`.
- Unauthenticated call gets `401` before any lookup.
- `JOB_MAX_USER_RETRIES` exceeded returns `409` with a clear message.
- Cancel request that the worker never confirms within `JOB_CANCEL_GRACE_MS` does not report the
  job as cancelled while it is still running.
- A job whose project was soft-deleted (`status: 'D'`) cannot be retried.
- Progress projection on a job with zero events returns a valid all-`pending` stage list rather
  than throwing.

## 10. Definition of Done

- [ ] Retry resumes from the checkpoint when the failure allows it, and says why when it cannot.
- [ ] A duplicate retry or cancel click never starts a second writer on the same project.
- [ ] Every invalid state transition is rejected with `409` and the current status in `details`.
- [ ] A failed or cancelled job is still fully readable, with its events, after the control call.
- [ ] The progress payload never contains a fabricated percentage.
- [ ] Every user-facing job message comes from the catalogue and contains no internal id, path,
      stack trace, or credential.
- [ ] Retry and cancel write audit events; neither writes secrets into audit context.
- [ ] Permissions and tenant scope are enforced in the service, not only in the route.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch on the
      touched files.
- [ ] No new `.env` keys. Cancel grace and retry ceiling are constants.

## 11. Documentation & ADR updates

- `docs/architecture.md` §5: add the sentence that retry resumes from a checkpoint and cancel is
  cooperative at stage boundaries, matching what now exists.
- New ADR in `docs/adr/`: "Retry reuses the same Job document; reingest creates a new one" —
  context (backend §37, solution §4.7), decision, consequences for processing history,
  alternatives (a new job per retry with a parent link), escape hatch.
- `backend/solution.md` §4.7: confirm the retry table matches the implemented modes; update only
  if approval changes them.
- Note for Phase 35: the stage labels and event codes defined here are the i18n keys the UI needs.

## 12. Risks & open questions

1. **Where does progress live?** Proposal: extend Phase 20's `GET /api/v1/jobs/:jobId` with the
   `progress` block rather than adding `GET /jobs/:jobId/progress`. Confirm, because Phase 20 owns
   that response and Phase 35 will code against whichever is chosen.
2. **Phase 20 field overlap.** **Decided.** Phase 20 owns `eventCode`, `severity`,
   `progressCounters`, `stageCheckpoint`, `cancelRequestedAt`. This phase adds retry metadata
   (`retryRequestedAt`, `retryCount`, `lastRetryMode`, `cancelRequestedBy`).
3. **Route shape.** `POST /api/v1/jobs/:jobId/retry` (flat) versus
   `POST /api/v1/projects/:projectId/jobs/:jobId/retry` (nested, matching solution §4.7's
   `POST .../jobs/:jobId/retry`). Proposal: flat, with the project resolved from the job; needs
   confirmation because Phase 35 builds URLs from it.
4. **Permission choice.** Proposal: `knowledge.trigger` for both verbs. Should cancel require a
   stronger permission, or should the job's initiating user be able to cancel their own job
   without it?
5. **Retry that is really a rebuild.** When the graph stage failed, retry sets mode `full`. Does
   "full" mean re-running from `materialize_docs`, or from `validate_upload` against the stored
   GridFS bytes? Phase 28 and Phase 29 both depend on the answer.
6. **`retrying` as a stored state.** It exists in backend §32 and §153. Confirm it should be
   persisted, or whether a retry should move straight to `pending`.
7. **Cancel and partial state.** If a stage is cancelled after some document sections were
   written, do those stay (proposal: yes, they are re-usable on retry) or are they discarded?
8. **Counter ownership.** `itemsProcessed` and `itemsFailed` must be incremented by the stage
   implementations in Phases 25–28. Confirm they will write these fields rather than emitting
   only events, otherwise the projection has to derive counts from event context.
