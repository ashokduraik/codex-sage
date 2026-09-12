# Phase 62 — Observability & reliability pass

- **Layer:** BE
- **Depends on:** Phase 61 (security & tenant-isolation hardening pass)
- **Unblocks:** Phase 63 (CI and Playwright need stable diagnostics when E2E fails)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §104 (observability), §105 (error correlation),
  §109 (retry strategy), §110 (external service failure), §151 (backend reliability),
  §152 (authoritative user-facing state), §153 (consistent state transitions),
  §154 (structured async state for premium UX); `backend/solution.md` §4.6 (failure classes,
  worker-crash row), §9.1 (logging posture); `docs/architecture.md` §9 (SSE events), §10
  (errors and correlation); prior phases **02** (error model, Pino redaction, `requestContext`),
  **10** (audit correlation), **21** (worker logging, lease sweeper, retry/backoff),
  **50** (chat SSE lifecycle)

## 1. Goal

After this phase an operator or support engineer can follow a single reference id from a user-visible
failure through HTTP logs, worker logs, and (where applicable) the chat SSE terminal frame — without
ever seeing source bytes, chat content, or secrets in logs. The worker and chat paths use the same
correlation rules phase 02 established for the API; lease recovery and automatic retry remain owned
by phase 21 and are only **verified and logged consistently**, not reimplemented. Readiness checks
report only what the process can honestly observe (for example Mongo reachability and whether a worker
has written a recent heartbeat document), not invented latency percentiles or SLO dashboards. You can
see it working by triggering a failed ingest stage, a repository probe failure, and a chat stream
error: each leaves structured log lines with `correlationId` / `reqId`, domain fields (`jobId`,
`projectId`, `conversationId` where relevant), and stable error codes — and none of the forbidden
payloads from backend §149.

## 2. Why this phase is here

Phases 02 and 21 already define correlation ids, redaction, worker child loggers, and sweeper/retry
behaviour. By the time ingest, repository sync, and chat SSE exist, those pieces must be **wired
end-to-end** (HTTP enqueue → job row → worker stages → optional SSE terminal error) and any remaining
gaps closed in one reviewable pass. It cannot come earlier: there is nothing to observe until auth,
jobs, ingest, chat, and the phase 61 hardening review exist. It must precede phase 63 so CI failures
and Playwright flakes produce actionable logs rather than silent gaps. Phase 05 (evaluation) is
**unwritten** — this phase does **not** define SLOs, latency budgets, or capacity targets derived
from benchmark numbers.

## 3. Scope

### In scope

- **Gap analysis and closure** for logging and correlation across: API handlers, worker runtime,
  ingest handlers (25–28), repository sync (32), LangGraph/chat runs (47–50), and external
  dependency boundaries (Mongo, Ollama, CodeGraph, git providers) per §110 — log outcomes and codes,
  never raw responses that may contain tokens or source.
- **Propagation:** ensure `job.correlationId` (and audit `correlationId` where phase 10 defines it)
  is set from the originating HTTP request when a handler enqueues work, and that the worker enters
  `requestContext` with that id (phase 02 §4.4, phase 21 §4.7) so support can search one reference.
- **SSE / chat:** when a stream ends in the terminal `error` event (phase 02 `streamErrors.js`, phase
  50 handler), log at `error` with the same `reference`, plus non-sensitive run identifiers
  (`conversationId`, `messageId`, `projectId`, `orgId`) — never message text, tool payloads, or
  evidence bodies.
- **Failure-category coverage** for §104: authentication failures, processing/knowledge failures,
  chat failures — each domain module logs with a stable `code` from `errorCatalog.js` at the
  boundary where the failure is classified; query-class failures stay out of scope (README §5).
- **Readiness / ops visibility (honest only):** extend or consolidate health/readiness reporting so
  operators can see API process up, Mongo check from phase 01, and **optional** worker liveness
  derived from a persisted heartbeat or last-seen timestamp — not queue depth estimates unless read
  from real Mongo counts.
- **Reliability verification (not reimplementation):** document and test that phase 21 sweeper,
  backoff, idempotency (phase 12), and phase 22 explicit retry paths still behave under the logging
  rules after the full stack exists; add logging hooks only where failures were previously silent.
- **Transition sanity:** lightweight assertions or integration tests that invalid job/lifecycle
  transitions rejected in code paths also emit a structured log line (§153), without new product
  features.

### Out of scope (owner phase)

- Error-code catalog, Pino redaction paths, `genReqId`, global handler envelope — **Phase 02**
  (extend only if a new **allowlisted** log field is approved in §12).
- Claim, heartbeat, lease sweeper, per-project lock, worker retry scheduling — **Phase 21**.
- Audit event schema and writer — **Phase 10** (this phase may require audit rows to carry
  `correlationId` if not already enforced).
- Job progress APIs and human-readable events — **Phases 20 and 22**.
- SSE event shapes and chat handler ownership of `reply` — **Phase 50**.
- Metrics backends, APM, dashboards, alerting rules, and SLO targets — **blocked on Phase 05** and
  product ops choices; no Datadog/Prometheus wiring unless explicitly approved (§12).
- Production deployment, containers, and load balancers — **D11**.
- Frontend error display — **Phases 13+**; E2E assertion of logs — **Phase 63**.

## 4. Design

### 4.1 What phase 02 already owns (do not reinvent)

| Concern | Owner | This phase may only… |
|---|---|---|
| `REQ-` correlation id = Fastify `request.id` | 02 | Propagate into jobs/audit; never honour client-supplied ids |
| Error envelope + `streamErrors.js` | 02 | Ensure chat handler calls the builder and logs match `reference` |
| Pino redact + deny-by-default serializers | 02 | Add paths only after §12 approval |
| `retryPolicy.js` classification | 02 / 21 | Log classification outcome; do not duplicate backoff math |
| Worker child logger field set | 21 | Align missing fields (`correlationId` binding) with API conventions |

### 4.2 Correlation propagation (HTTP → job → worker)

```text
HTTP handler (owns reply)
  correlationId = request.id from requestContext
  enqueue job with job.correlationId = correlationId   ← gap if not set today
  audit (10) includes same correlationId on sensitive actions

Worker claim (21)
  enter requestContext { correlationId: job.correlationId }
  child logger binds workerId, jobId, jobType, orgId, projectId, attempt, stage, correlationId
```

**PROPOSED:** if `job.correlationId` is absent on legacy rows, the worker generates a new id with
the prefix decided in §12 question 1 — it does not reuse `REQ-` for work that never had an HTTP
request (scheduled `repo_sync`, retention ticks).

Chat SSE runs that outlive the POST request **PROPOSED:** keep the POST's `request.id` as the
stream's `reference` in the terminal frame and in logs for the whole run; do not rotate mid-stream
unless product asks otherwise (§12 question 2).

### 4.3 Logging matrix (gaps to fill)

| Area | Log when | Required fields (non-sensitive) | Must never log |
|---|---|---|---|
| Auth | Login failure, lockout, revoked session | `code`, `orgId?`, `userId?`, `reqId` | Password, refresh token, cookie values |
| Enqueue | Job created from upload/sync/chat | `jobId`, `jobType`, `projectId`, `correlationId` | Zip bytes, repo token, idempotency body |
| Ingest stage | Stage fail/complete (25–28) | `jobId`, `stage`, `code`, counts from counters | Paths with customer filenames if policy forbids; file contents |
| Repo / Ollama / CodeGraph | External failure §110 | `code`, `dependency`, `retryability`, `attempt` | Provider response bodies, URLs with embedded tokens |
| Chat SSE | Stream start, terminal `error`, abnormal disconnect | `conversationId`, `messageId`, `reference`, `code` | User question, assistant draft, tool output, evidence text |
| Sweeper / retry (21) | Requeue, fail exhausted, shutdown release | `jobId`, `eventCode`, `attempt` | Checkpoint cursor payloads if they embed paths |

All lines use structured JSON (Pino). Free-text `msg` is for humans; support searches on
`correlationId` / `reqId` and `code`.

### 4.4 Readiness and worker liveness (no fake metrics)

Phase 01 `GET /health` (or readiness) stays the API process check. **PROPOSED** additive checks
(approval required before implementation):

```json
{
  "status": "ok | degraded | unavailable",
  "checks": {
    "mongo": { "status": "ok | unavailable", "error": { "code": "MONGO_UNAVAILABLE" } },
    "worker": {
      "status": "ok | unknown | stale",
      "lastSeenAt": "2026-09-12T16:00:00.000Z"
    }
  }
}
```

`worker.lastSeenAt` comes only from a real persisted field (for example a `workerHeartbeats`
document updated by phase 21 on each sweep or heartbeat) — not from in-memory API state. If no
worker has ever registered, `status: 'unknown'` is honest; do not report `ok` without evidence.
No request-rate, CPU, or latency numbers appear unless backed by a real probe (§12 question 4).

### 4.5 Reliability pass (verify 21 / 12 / 110, log remaining holes)

| Mechanism | Owner | This phase |
|---|---|---|
| Lease expiry → requeue/fail | 21 | Integration test + confirm `job.interrupted_requeued` logs include `correlationId` |
| Idempotent duplicate POST | 12 | Log `IDEMPOTENCY_KEY_REUSE` at `info`, not duplicate job creation |
| External dependency down | 110 | Classify `temporary` vs `permanent`; preserve project/knowledge state; log once per failure class per job attempt |
| Invalid state transition | 17, 20, 22 | Reject + log `code` (e.g. conflict) — no silent no-ops |

No new retry counters or sweeper intervals — constants stay in phase 21 modules.

### 4.6 Error tracking hook (optional, not fake telemetry)

Phase 02 listed "Error tracking" as phase 62. **PROPOSED:** a single platform adapter
`reportDefect(error, context)` that no-ops in development/tests and forwards **already redacted**
context to an external reporter **only if** env provides a DSN — never send bodies, chat, or
source. Which vendor (if any) is an open question (§12 question 3). Until approved, implement the
interface and unit-test the no-op path only.

## 5. Data model changes

**PROPOSED (needs approval):** optional collection or single-document store for worker liveness, for
example `workerHeartbeats`: `workerId`, `lastSeenAt`, `hostname`, `status: 'A'`, updated by the
worker runtime on a named constant interval. If product prefers reading `jobs` for "any running job
with fresh `heartbeatAt`" instead of a new collection, ask in §12 question 5 — do not add both.

No change to `Job`, `JobEvent`, or audit schema unless phase 10 audit rows lack `correlationId`
(then additive field only, owned in coordination with phase 10 docs).

## 6. API contract — PROPOSED (needs approval before implementation)

### 6.1 Readiness response extension

If §4.4 is approved, extend the existing health/readiness JSON (phase 01 path — confirm whether
`/api/v1/health` or a separate readiness route) with the `checks.worker` object in §4.4. Errors
nested under `checks.*.error` remain `{ code }` only, not full envelopes.

### 6.2 No new domain routes

Observability is primarily logging and optional readiness fields. No new CRUD for "logs" or
"metrics" in the product API.

### 6.3 Internal `reportDefect` context shape (if error tracking approved)

```json
{
  "reference": "REQ-…",
  "code": "INTERNAL_ERROR",
  "route": "POST /api/v1/conversations/:id/messages",
  "orgId": "…",
  "projectId": "…",
  "jobId": "…",
  "conversationId": "…"
}
```

No `messageText`, `stack` only at `error` level in logs — the adapter receives the same allowlist.

## 7. Configuration & environment variables

**PROPOSED only if error tracking is approved:**

| Variable | Purpose |
|---|---|
| `ERROR_TRACKING_DSN` | Optional reporter endpoint; absent = no-op |

Worker heartbeat write interval and stale threshold are **named constants** next to the worker or
health module, not env vars (`.cursor/rules/env-config.mdc`). `LOG_LEVEL` from phase 01 continues
to drive verbosity.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `WORKER_LIVENESS_STALE_MS` | TBD after approval | `modules/health/` or `worker/` | When `checks.worker` becomes `stale` |
| `WORKER_HEARTBEAT_PERSIST_INTERVAL_MS` | TBD | `worker/workerRuntime.js` | How often to upsert liveness document |

Values are **not** invented here pending §12 question 5 — placeholders in code must not ship until
approved.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/platform/requestContext.js` | **Verify/extend:** worker entry documents `correlationId` contract |
| `backend/src/platform/logger.js` | **Extend only if approved:** extra redact paths or child-logger helper |
| `backend/src/platform/streamErrors.js` | **Verify:** chat terminal frame fields match logs |
| `backend/src/platform/errorTracking.js` (+ `.test.js`) | **New (optional):** `reportDefect` no-op + guarded forward |
| `backend/src/modules/health/health.service.js` (+ tests) | **Extend:** optional worker liveness from persisted heartbeat |
| `backend/src/worker/workerRuntime.js` | **Extend:** persist liveness; ensure context enter/exit |
| `backend/src/worker/workerLogger.js` | **Align:** bind `correlationId` on every job line |
| `backend/src/modules/jobs/jobs.service.js` (or enqueue sites) | **Extend:** set `correlationId` on create from HTTP context |
| `backend/src/modules/ingest/ingest.handler.js` | **Extend:** stage failure logs use catalog codes + counters only |
| `backend/src/modules/chat/` (phase 50 SSE handler) | **Extend:** stream lifecycle logs; terminal error log line |
| `backend/src/http/app.js` | **Verify:** auth failures hit global handler + structured log |
| `docs/architecture.md` §10 | Document correlation propagation HTTP → job → worker → SSE |

Paths are illustrative; exact module names follow the codebase at implementation time.

## 9. Tests (≥ 80% line and branch)

### Unit

- Enqueue helper copies `request.id` into `job.correlationId` when context exists; scheduled jobs
  behaviour matches §12 decision for missing HTTP context.
- `reportDefect` is a no-op without DSN; with DSN stub, payload contains allowlisted keys only.
- Health/readiness: Mongo down → `degraded`/`unavailable`; worker stale → `checks.worker.status`
  reflects constant threshold; never returns fabricated timings.
- Chat stream error builder + handler: log stub receives `reference` equal to terminal SSE frame.

### Integration (external Mongo `codex_sage_test`, ADR 0009)

- Upload enqueue → worker claim: grep structured logs (test log capture) for same `correlationId`
  on API and worker lines for one job id.
- Simulated Ollama/CodeGraph failure (mocked at module boundary): job fails with `temporary` or
  `permanent`; project `knowledgeHealth` unchanged per §110; log contains `code`, not provider body.
- Expired lease fixture (phase 21 harness): requeue log includes `job.interrupted_requeued` and
  `correlationId`.

### Unhappy paths

- Log capture asserts no authorization header, password field, chat `content`, or GridFS payload
  in any line during ingest + chat failure scenarios.
- Invalid job transition attempt logs once at `warn`/`error` with stable `code`, does not mutate state.

## 10. Definition of Done

- [ ] Correlation id flows HTTP → job → worker logs for at least upload-ingest and one chat failure
      path; SSE terminal `error.reference` matches the POST request's `reqId`.
- [ ] Phase 02 redaction and deny-by-default rules unchanged in spirit; any new redact path approved
      in §12.
- [ ] Phase 21 sweeper/retry/backoff behaviour verified by test; this phase did not fork retry logic.
- [ ] Auth, processing, knowledge, and chat failure categories emit structured logs with catalog
      `code`s (§104).
- [ ] Readiness reports worker liveness only from persisted evidence, or §12 chose an alternative.
- [ ] No SLOs, latency SLIs, or fake queue metrics documented or implemented.
- [ ] No source bytes, secrets, or full chat content in test log assertions.
- [ ] `npm run lint`, `npm test` pass; touched files ≥ 80% line and branch coverage.

## 11. Documentation & ADR updates

- Update `docs/architecture.md` §10 with a short "Correlation across processes" subsection (HTTP,
  worker, SSE).
- If `workerHeartbeats` or error-tracking DSN is added, record an ADR only when the decision is
  approved — do not pre-write Accepted ADRs for open questions.
- `backend/solution.md` §9.1: confirm alignment; change only if implementation diverges after approval.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Worker correlation prefix.** Phase 02 question 6: reuse `REQ-` on `job.correlationId` for
   HTTP-originated jobs only, or always use `JOB-` in the worker for support triage?
2. **Long-lived chat runs.** Should logs after the POST handler returns keep the original `REQ-`
   reference for the entire LangGraph run, or assign a run-specific id linked in structured fields?
3. **Error tracking vendor.** Is any external reporter in scope for local/dev (Sentry, etc.), or is
   structured stdout logging sufficient for MVP under D11?
4. **Performance / capacity (§104).** Without phase 05 SLOs, which honest signals are required:
   Mongo pool saturation, Ollama queue depth, ingest duration — or defer all until evaluation exists?
5. **Worker liveness source.** New `workerHeartbeats` collection vs inferring from `jobs.heartbeatAt`
   vs process-local only (no API check)?
6. **Log field allowlist expansion.** May logs include repository hostnames, file path basenames, or
   model ids? Each new field needs explicit approval per §148–§149.
7. **Stale worker in readiness.** Should API mark itself `degraded` when worker is stale, or only
   surface `checks.worker` while API stays `ok`?
8. **Audit correlation gaps.** Does every security-sensitive action in phase 61 review already persist
   `correlationId` on `AuditEvent`? If not, fix here or send back to phase 10 scope?
