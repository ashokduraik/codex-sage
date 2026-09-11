# Phase 21 — Worker process: claim, heartbeat, lease sweeper, scheduler

- **Layer:** BE
- **Depends on:** Phase 20 (Job / JobEvent models and read APIs)
- **Unblocks:** Phase 22, 25, 27, 32, 60
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §31 (trackable jobs), §32 (job states),
  §93 (concurrency on one project), §94 (knowledge-update serialization), §95 (long-running
  operations), §109 (retry strategy), §151 (automatic recovery), §153 (valid transitions);
  `backend/solution.md` §7 (jobs without Redis), §4.6 (checkpoints, worker-crash row, failure
  classes), §4.8B (scheduled ticks); `docs/architecture.md` §2, §3, §5

## 1. Goal

The worker entrypoint created in Phase 01 stops idling and becomes a real job runner: it polls
the MongoDB `jobs` collection, claims one job atomically, heartbeats while it runs, releases its
lease when it finishes, and recovers jobs abandoned by a crashed worker. Only one knowledge or
sync writer runs per project, and temporary failures come back automatically with backoff.

You can see it working with no ingest code: insert a `pending` job of a test type by hand and
watch the worker log claim, heartbeat and completion, with `JobEvent` lines readable through the
Phase 20 APIs. `SIGKILL` the worker mid-job, restart it, and the sweeper requeues the job while
the handler resumes from its checkpoint.

## 2. Why this phase is here

Phase 20 gave jobs a schema and a read surface, but nothing executes them. Ingest stages
(25, 26, 28), CodeGraph writes (27), repository sync (32) and retention (60) are all *handlers*
that plug into this loop; building them first would force each to invent its own claiming and
retry rules. It cannot come earlier because there is no `Job` document to claim, and it must not
come later because the per-project serialization rule (backend §93, §94) has to exist before the
first writer is written rather than be retrofitted around it.

## 3. Scope

### In scope

- Replace the idling interval in `backend/src/worker/index.js` with the polling runtime.
- Atomic claim: `findOneAndUpdate` moving `jobStatus: 'pending'` to `'running'`.
- Heartbeat timer refreshing `heartbeatAt` / `leaseExpiresAt` while a job runs.
- Lease sweeper that requeues or fails `running` jobs whose lease expired.
- Per-project exclusivity so only one knowledge or sync writer runs per project.
- Job-type handler registry, so later phases register handlers without touching the loop.
- Failure classification (`temporary`, `permanent`, `user_action_required`) with backoff.
- Scheduled ticks driven by `scheduledAt`, for use by Phases 32 and 60.
- Configurable poll interval, concurrency, lease TTL and attempt ceiling.
- Resume-from-checkpoint semantics handed to the handler.
- Graceful shutdown: stop claiming, then release the in-flight lease and lock.
- Structured worker logging (worker id, job id, type, stage, correlation id).

### Out of scope (owner phase)

- Retry and cancel endpoints and the progress projection — **Phase 22**.
- Ingest stages S0–S2 — **Phase 25**; S3 — **Phase 26**; S4–S6 — **Phase 28**.
- The CodeGraph filesystem writer lock and index/sync calls — **Phase 27**.
- The 30-minute `repo_sync` cadence — **Phase 32**; retention schedules — **Phase 60**.
- Completion notifications — **Phase 58**. Multi-machine fleets and priority queues.

## 4. Design

### 4.1 Runtime shape

`src/worker/index.js` keeps the Phase 01 boot sequence (process handlers, config, Mongo, shutdown
hooks) and replaces the idle interval with `startWorkerRuntime()`, which owns three timers: poll
(`WORKER_POLL_INTERVAL_MS`), heartbeat (`WORKER_HEARTBEAT_INTERVAL_MS`) and sweep
(`WORKER_SWEEP_INTERVAL_MS`). Claimed jobs run as async tasks in an in-memory map keyed by job
id; the runtime only claims while that map is smaller than `WORKER_MAX_CONCURRENT_JOBS`. There
are no worker threads — concurrency is async I/O inside one process (arch §2). `workerId` is
`${hostname}-${pid}-${bootSuffix}`; the suffix keeps two workers distinguishable after a fast
restart, which matters for lease attribution.

### 4.2 Handler registry

Handlers register by job type at boot, before the first poll, so the loop never imports a domain
module:

```text
registerJobHandler({
  type: 'ingest',
  exclusiveScope: 'project',   // or 'none'
  maxAttempts: 5,
  run: async (context) => { … }
})
```

`context` carries `job`, `stageCheckpoint`, a child logger, `recordEvent()`, `saveCheckpoint()`,
`isCancelRequested()` and an `AbortSignal` that fires on shutdown or lease loss. A handler returns
`{ result: 'completed' | 'completed_with_warnings', summary }` or throws a classified error. The
claim filter only matches registered types, so a worker build that does not know a type leaves
those jobs alone instead of failing them.

### 4.3 Atomic claim

```text
findOneAndUpdate(
  { status: 'A', jobStatus: 'pending', jobType: { $in: registeredTypes },
    scheduledAt: { $lte: now } },
  { $set: { jobStatus: 'running', workerId, heartbeatAt: now,
            leaseExpiresAt: now + leaseTtlMs }, $inc: { attempt: 1 } },
  { sort: { scheduledAt: 1, createdAt: 1 }, returnDocument: 'after' })
```

A single-document update is atomic, so two racing workers produce exactly one winner; the loser
gets `null` and polls again. `scheduledAt` defaults to creation time, which makes "run now" and
"run later" the same code path (§4.6).

### 4.4 Per-project serialization

Exclusivity spans jobs, so it cannot live in one document update. After the claim and before the
handler runs, acquire a lock in a dedicated collection with a unique key:

```text
acquireProjectJobLock(organizationId, projectId, jobId)
  → conditional upsert; succeeds when no live lock exists or the existing expiresAt has passed
  → duplicate-key error → the project is busy
```

Busy is not a failure: the job returns to `pending` with
`scheduledAt = now + WORKER_PROJECT_BUSY_RETRY_MS` and a `JobEvent` saying another update is
already running on the project — deterministic queueing as backend §94 asks. Handlers with
`exclusiveScope: 'none'` skip the lock. The lock's `expiresAt` is refreshed by the same heartbeat
as the job lease, so a crashed holder cannot block a project forever. This is the *job-level*
gate; the CodeGraph filesystem writer lock that wraps the actual index calls is Phase 27 and sits
inside the handler.

### 4.5 Heartbeat, lease and the sweeper

The heartbeat sets `heartbeatAt = now` and `leaseExpiresAt = now + WORKER_LEASE_TTL_MS` for every
in-flight job and refreshes its project lock. The update is conditional on `workerId` still
matching; if it matches nothing the worker has lost ownership and the runtime aborts that job's
signal so it stops writing. Lease TTL must be well above the heartbeat interval (default 6x).

Every sweep interval the sweeper scans `{ status: 'A', jobStatus: 'running',
leaseExpiresAt: { $lt: now } }` and per job:

| Condition | Outcome |
|---|---|
| `attempt < maxAttempts` | back to `pending`, `scheduledAt = now + backoff`, event "Processing was interrupted and will resume" |
| `attempt >= maxAttempts` | `jobStatus: 'failed'`, `failureClass: 'temporary'`, code `WORKER_LEASE_EXPIRED` |

Either branch releases the project lock held by that job id and writes a `JobEvent`. The job keeps
`currentStage` and `stageCheckpoint`, so the next claim resumes instead of restarting (solution
§4.6 worker-crash row), and the failed job is never removed (backend §36).

### 4.6 Failure classes, backoff and scheduled ticks

Handlers throw an error carrying `failureClass` and a stable `code`:

| Class | Loop behaviour |
|---|---|
| `temporary` | requeue with exponential backoff plus jitter while attempts remain (backend §109) |
| `permanent` | fail immediately; explicit retry only (Phase 22) |
| `user_action_required` | fail immediately; the message tells the user what to change |

Backoff is `min(base * 2^(attempt-1), max)` plus jitter, written into `scheduledAt`. An
unclassified error is treated as `temporary` but logged at `error` with the handler name, because
an unclassified error is a bug, not a policy. Since the claim filter already honours
`scheduledAt`, backoff, the 30-minute `repo_sync` cadence (solution §4.8B) and retention runs
(§12.3) share one mechanism. This phase adds only the generic part: `scheduledAt` support in the
claim, and a helper a handler can call on completion to enqueue its own next occurrence
(`nextDueAt`). Phases 32 and 60 choose the cadences.

### 4.7 Resume, cancellation, shutdown, logging

A handler receives `currentStage` and `stageCheckpoint` and must skip stages already recorded
complete (solution §4.6 hard rule 4: a resumed stage must not duplicate document sections or
start a second graph writer). The runtime never interprets checkpoint contents; it only
persists what the handler saves via `saveCheckpoint({ lastCompletedStage, cursor?, updatedAt })`. `isCancelRequested()` reads the flag Phase 22 sets; this phase provides the
plumbing and the `cancelled` terminal transition only.

Graceful shutdown registers a Phase 01 hook that stops the poll timer, waits up to
`WORKER_DRAIN_TIMEOUT_MS`, then for anything still running sets `jobStatus: 'pending'` with
`scheduledAt = now`, clears `workerId`, releases the lock and writes an event — so a normal deploy
costs no lease-timeout delay.

One structured child logger per job with `{ workerId, jobId, jobType, organizationId, projectId,
attempt, stage, correlationId }`. Claim, stage transitions, requeue, failure and completion at
`info`; heartbeat and empty polls at `debug`. Never log source bytes, credentials or tokens
(backend §148).

## 5. Data model changes

`Job` and `JobEvent` — including worker fields (`workerId`, `attempt`, `maxAttempts`,
`heartbeatAt`, `leaseExpiresAt`, `scheduledAt`, `failureClass`, `currentStage`,
`stageCheckpoint`, `progressCounters`, `cancelRequestedAt`, `correlationId`) — belong to
**Phase 20**. This phase does not add those fields. It only adds `projectJobLocks` and the
claim/sweep indexes on `jobs` if Phase 20 did not already create those indexes.

Canonical checkpoint shape (owned by Phase 20, consumed here):

```text
stageCheckpoint: { lastCompletedStage: string, cursor?: unknown, updatedAt: Date }
```

New collection `projectJobLocks`: `organizationId`, `projectId`, `jobId`, `workerId`,
`lockScope` (`'project_writer'`), `acquiredAt`, `expiresAt` (UTC), and the mandatory
`status: 'A' | 'D'` (required, default `'A'`). Indexes: unique
`{ organizationId, projectId, lockScope }` partial on `status: 'A'`; `{ expiresAt: 1 }` for the
sweeper. On `jobs`: `{ status, jobStatus, jobType, scheduledAt }` for the claim and
`{ status, jobStatus, leaseExpiresAt }` for the sweep. All created by a migration in the Phase 03
migration folder, not by `autoIndex` in production.

## 6. API contract — PROPOSED (needs approval before implementation)

**No HTTP endpoint is added or changed.** The worker has no inbound API and talks to the API
process only through MongoDB (arch §9). Two internal contracts still need approval because later
phases depend on the exact field names.

Claimed job as the handler sees it (subset, PROPOSED):

```json
{
  "jobId": "665f1c9d4b2a8e0012a4f001",
  "organizationId": "6650aa1b4b2a8e0012a4e001",
  "projectId": "6651bb2c4b2a8e0012a4e002",
  "jobType": "ingest",
  "jobStatus": "running",
  "attempt": 2,
  "maxAttempts": 5,
  "workerId": "host-1-4821-a7c3",
  "scheduledAt": "2026-09-11T10:42:00.000Z",
  "leaseExpiresAt": "2026-09-11T10:43:07.000Z",
  "currentStage": "materialize_docs",
  "stageCheckpoint": {
    "lastCompletedStage": "exclude_apply",
    "updatedAt": "2026-09-11T10:41:50.000Z"
  },
  "correlationId": "req_01J9ZK4T2M"
}
```

`JobEvent` written by the loop itself (PROPOSED; the full human-readable catalogue is Phase 22):

```json
{
  "jobId": "665f1c9d4b2a8e0012a4f001",
  "eventCode": "job.interrupted_requeued",
  "severity": "warning",
  "message": "Processing was interrupted and will resume automatically.",
  "context": { "attempt": 2, "maxAttempts": 5 },
  "createdAt": "2026-09-11T10:44:01.000Z"
}
```

Event codes this phase owns: `job.claimed`, `job.project_busy_requeued`,
`job.interrupted_requeued`, `job.retry_scheduled`, `job.failed_permanent`,
`job.failed_attempts_exhausted`, `job.released_on_shutdown`.

## 7. Configuration & environment variables

**None.** No new `.env` keys. Worker timings, concurrency, lease, and backoff are named
constants in the worker module (`.cursor/rules/env-config.mdc`). `process.env` is still read
only in `src/platform/config.js`.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `WORKER_POLL_INTERVAL_MS` | `2000` | `worker/worker.constants.ts` | Delay between claim attempts when idle |
| `WORKER_MAX_CONCURRENT_JOBS` | `2` | `worker/worker.constants.ts` | In-flight jobs per worker process |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `10000` | `worker/worker.constants.ts` | Lease refresh cadence |
| `WORKER_LEASE_TTL_MS` | `60000` | `worker/worker.constants.ts` | Lease lifetime; must exceed the heartbeat interval |
| `WORKER_SWEEP_INTERVAL_MS` | `30000` | `worker/worker.constants.ts` | Expired-lease scan cadence |
| `WORKER_MAX_ATTEMPTS` | `5` | `worker/worker.constants.ts` | Default attempt ceiling when a handler sets none |
| `WORKER_RETRY_BACKOFF_BASE_MS` | `5000` | `worker/worker.constants.ts` | First temporary-failure delay |
| `WORKER_RETRY_BACKOFF_MAX_MS` | `300000` | `worker/worker.constants.ts` | Backoff ceiling |
| `WORKER_PROJECT_BUSY_RETRY_MS` | `15000` | `worker/worker.constants.ts` | Requeue delay when the project lock is held |
| `WORKER_DRAIN_TIMEOUT_MS` | `30000` | `worker/worker.constants.ts` | Shutdown wait before releasing in-flight leases |

Startup must fail if `WORKER_LEASE_TTL_MS <= WORKER_HEARTBEAT_INTERVAL_MS`: that combination
silently steals leases from healthy workers. Assert this in a unit test on the constants
module, not via env validation.

## 8. Files to create or change

| Path (source + colocated `*.test.js`) | Purpose |
|---|---|
| `backend/src/worker/index.js` | **Replace** the Phase 01 idle interval with `startWorkerRuntime()` |
| `backend/src/worker/workerRuntime.js` | **New:** timers, in-flight map, claim/run/finish orchestration |
| `backend/src/worker/jobClaim.js` | **New:** atomic claim plus requeue and finish transitions |
| `backend/src/worker/jobHeartbeat.js` | **New:** conditional lease and lock refresh |
| `backend/src/worker/leaseSweeper.js` | **New:** expired-lease requeue or fail |
| `backend/src/worker/handlerRegistry.js` | **New:** register and look up handlers by job type |
| `backend/src/worker/retryPolicy.js` | **New:** failure classes, backoff, attempt ceiling |
| `backend/src/worker/projectJobLock.js` | **New:** lock model, acquire / refresh / release |
| `backend/src/worker/workerLogger.js` | **New:** per-job child logger with the fixed field set |
| `backend/src/worker/worker.constants.js` | **New:** recommended worker timings and concurrency |
| `backend/src/worker/worker.constants.test.js` | **New:** lease TTL exceeds heartbeat |
| `backend/src/migrations/…-project-job-lock.ts` | **New:** lock collection plus claim and sweep indexes (numbering from Phase 03) |

## 9. Tests (≥ 80% line and branch)

### Unit

- `retryPolicy` maps each failure class to requeue or fail, and an unclassified error to
  `temporary`; backoff grows exponentially, respects the ceiling, stays positive with jitter.
- `handlerRegistry` rejects a duplicate type and reports an unknown type without throwing.
- A heartbeat whose `workerId` condition matches nothing aborts the job signal.
- The runtime stops claiming at `WORKER_MAX_CONCURRENT_JOBS` and resumes when a slot frees.
- Shutdown returns an in-flight job to `pending` and releases its lock.
- Config rejects a lease TTL below the heartbeat interval.

### Integration (real MongoDB via the Phase 03 harness)

- Ten concurrent claims against one `pending` job: exactly one wins, `attempt` ends at 1.
- Two jobs on the same project: the second is requeued with `job.project_busy_requeued` and runs
  only after the first releases the lock (backend §93, §94); two jobs on different projects run
  concurrently.
- Crash recovery: a `running` job with an expired lease and a checkpoint is requeued, then
  resumes at the recorded stage without re-running completed stages.
- The sweeper fails the job instead of requeueing once `attempt >= maxAttempts`, and the failed
  job stays readable through the Phase 20 APIs (backend §36).
- A job with a future `scheduledAt` is not claimed until it is due.
- A lock whose `expiresAt` passed is taken over by another worker.
- Claim and lease queries are tenant-scoped; a job from another organization is never handed to a
  handler bound to a different scope.

### Unhappy paths

- Handler throws synchronously: the job still finishes and the lock is released.
- Mongo unreachable during a poll: logged, polling continues, no crash loop. Unreachable during a
  heartbeat: the job aborts rather than continuing to write.
- Two sweepers running at once requeue a job only once.
- `SIGTERM` mid-stage writes no partial checkpoint on top of an aborted stage.

## 10. Definition of Done

- [ ] `npm run dev:worker` claims a hand-inserted job, runs it, and logs completion.
- [ ] Two workers never run the same job; the concurrency test proves it.
- [ ] Only one knowledge or sync job runs per project; a second one waits and says so in its
      events.
- [ ] `SIGKILL` during a job leads to automatic requeue and resume from the checkpoint.
- [ ] `SIGTERM` during a job releases the lease and the project lock before exit.
- [ ] Temporary failures back off and retry; permanent and `user_action_required` failures stop
      immediately and remain inspectable.
- [ ] A job with a future `scheduledAt` is claimed only when due.
- [ ] No `process.env` read outside `src/platform/config.js`. Worker timings are constants, not
      env vars.
- [ ] No source bytes, credentials or tokens appear in worker logs.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch on
      every touched file.

## 11. Documentation & ADR updates

- `docs/architecture.md` §2, §3: confirm the claim/heartbeat/reclaim description matches the
  implementation and add `projectJobLocks` to the "What lives where" list.
- New ADR: "Per-project job serialization through a lease-based lock collection" — context
  (backend §93, §94; no Redis), decision, consequences (clock skew, TTL tuning), alternatives
  (single-worker deployment, a flag on the project document), escape hatch.
- `backend/solution.md` §7 is the source for this design; change it only if approval alters the
  field names in §6.

## 12. Risks & open questions

1. **Phase 20 field overlap.** **Decided.** Phase 20 owns the Job schema including
   `stageCheckpoint`. This phase only adds `projectJobLocks` and claim/sweep indexes.
2. **Lease TTL versus CodeGraph duration.** A ~2M-LOC index run (solution §4.4) can outlast any
   reasonable lease. Confirm the intent: heartbeat from a timer that keeps running during long
   CodeGraph calls (proposed), or a per-job TTL override supplied by the handler?
3. **Lock granularity.** Proposal: one `project_writer` lock covering ingest, reingest and
   `repo_sync`. Should document-only jobs (Phase 26) share it, or is a second scope needed?
4. **Two lock layers.** This job-level lock and Phase 27's CodeGraph filesystem lock overlap in
   purpose. Confirm both are wanted, or that Phase 27 should reuse this one.
5. **Clock skew.** Leases compare timestamps possibly written by different hosts. Should all lease
   arithmetic use server time (`$$NOW`)? Proposal: yes.
6. **Requeue versus fail on crash.** The sweeper requeues while attempts remain. For a stage that
   mutates the graph in place, is automatic requeue acceptable, or must a graph-mutating stage
   always wait for the explicit retry of Phase 22?
7. **Scope size.** Loop, lock collection, sweeper and retry policy in one phase sits at the upper
   end of 1–2 days. If review wants a split, the natural cut is claim + heartbeat + shutdown here
   and sweeper + scheduled ticks in a follow-up phase.
