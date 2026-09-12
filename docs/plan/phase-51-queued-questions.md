# Phase 51 — Queued questions during knowledge updates

- **Layer:** BE
- **Depends on:** Phase 28 (Q&A gate, publish, recovery exhaustion signals), Phase 50 (chat message
  create route, `Message` persistence, project ACL)
- **Unblocks:** Chat during ingest (frontend §53–54 queued UX; architecture §7 end-to-end)
- **Size:** 1–2 days
- **Requirements covered:** backend §93–§95, §144; solution §4.8, §5.8; architecture §6.1 step 4,
  §7; frontend §53–54 (queued while updating)

## 1. Goal

After this phase, asking a question while project knowledge is **updating** or **recovering** no
longer fails or blocks on SSE. The API persists the user message in an explicit **`queued`**
processing state, returns **`202 Accepted`** with `{ messageId, jobId }`, and **does not** open a
waiting event stream. When phase 28 publishes a validated graph (`ready` or `partially_available`),
unexpired queued messages are resumed against the **new current** graph only — never against a
partially mutated index. If queue wait expires or bounded recovery is exhausted, each affected
message becomes **`failed`** with a structured, **retryable** `KNOWLEDGE_UNAVAILABLE` error the UI
can offer to resend (frontend §63, backend §95).

You can see it working by starting a re-ingest, POSTing a chat message, receiving `202` with ids,
watching the message row stay `queued` linked to the active writer job, then — after ingest
completes — seeing the message transition to `accepted` and FLOW B run (or fail retryable if the
queue expired during a long recovery).

## 2. Why this phase is here

Phase 28 defines **`assertKnowledgeReadable`** and returns `action: 'queue'` when health or an
active graph writer forbids Q&A, but it does not persist queued messages, tie them to the blocking
job, resume them after publish, or fail them on expiry — that is this phase. Phase 50 owns the
happy-path SSE send when the gate returns `allow`; without 51, step 4 in architecture §6.1 would
either reject users during every ingest or incorrectly stream answers against stale or mutating
graphs (backend §93–§94, solution §4.8 hard rule on concurrency with chat).

It must follow 28 so resume runs only after **validated publish**, and 50 so the same
`POST .../messages` entrypoint, permissions, and idempotency patterns apply. It cannot follow FE
work: the contract (`202`, `queued`, `jobId`, terminal `KNOWLEDGE_UNAVAILABLE`) is backend-owned.

## 3. Scope

### In scope

- Extend the phase 50 message-create handler: when the gate returns `queue`, persist and return
  `202` — **no SSE body**, no LangGraph start.
- **`queued` message lifecycle** on `Message`: linkage to the active ingest/recovery **`jobId`**,
  `queuedAt`, `expiresAt` (duration **not** fixed here — evaluation / phase 05), optional
  `queueFailureCode` on terminal failure.
- **Resume path** for unexpired queued messages after successful publish (phase 28 S6 / gate
  `allow`): enqueue or invoke the same FLOW B entry used by phase 50 for an allowed send.
- **Failure path** when recovery exhausts (phase 28 §4.3) or **`expiresAt`** passes: mark
  `failed`, set retryable `KNOWLEDGE_UNAVAILABLE` on the message (and error envelope if the client
  polls message detail).
- **Expiry sweeper** or equivalent periodic check so expired rows fail without requiring a client
  connection (backend §95 long-running operations).
- Internal hook **`onKnowledgePublished({ orgId, projectId, knowledgeVersionId })`** callable from
  phase 28 finalize — exact wiring (direct call vs job enqueue) is **§12**.
- Guarantee: **never** start UNDERSTAND/tools against a graph while `assertKnowledgeReadable`
  would return `queue` or `deny` for partial/mutating state (architecture §7, backend §94).

### Out of scope (owner phase)

- Gate health enum mapping and recovery job shape — **phase 28** (this phase consumes signals only).
- SSE event types, stream lifecycle, idempotency on first send — **phase 50** (extended, not replaced).
- Clarification POST and `awaiting_clarification` — **phase 52**.
- Message edit / assistant retry — **phase 53**.
- Frontend queued indicator and poll UX — **frontend §53–54**, phase 55.
- Queue **duration** numeric default — **phase 05** (evaluation); no invented constant in code
  until approved.
- In-app rate limiting — **out of product scope** (phase 12, README §4; `RATE_LIMITED` remains
  edge/upstream only).

## 4. Design

### 4.1 Decision flow on `POST .../messages`

```text
POST /conversations/:id/messages  (phase 50)
  auth: chat.ask + project membership + conversation scope
  gate = assertKnowledgeReadable(project)

  if gate.action === 'deny'
    → 4xx/503 with KNOWLEDGE_UNAVAILABLE (or gate.code) — no Message row for new content
       (exact status for failed health: align phase 50 — §12)

  if gate.action === 'queue'
    → persist Message { role: user, processingStatus: 'queued', content, jobId: activeWriterJobId,
                        queuedAt, expiresAt: queuedAt + DURATION_TBD }
    → 202 { messageId, jobId }   STOP — no SSE

  if gate.action === 'allow'
    → existing phase 50 path (accepted → SSE → LangGraph)
```

`activeWriterJobId` is the ingest/recovery/**repo_sync** job currently holding the per-project
writer or driving `knowledgeHealth: updating` — resolved from phase 21 job queries scoped by
`orgId`, `projectId`, and active job types (ingest, recovery if distinct). If multiple candidates
exist, behavior is **§12** (deterministic pick vs reject).

### 4.2 Queued message state machine

```text
                    ┌──────────────────────────────────────┐
                    │ queued (persisted, no graph work)     │
                    └───────────────┬──────────────────────┘
                                    │
          publish + unexpired       │       expiresAt OR recovery exhausted
                    ▼               ▼
            accepted / running          failed
            (hand off to 50)            KNOWLEDGE_UNAVAILABLE, retryable
                    │
                    ▼
            completed | failed | awaiting_clarification (52)
```

- **`queued` → `accepted`:** resume trigger runs FLOW B with the **current**
  `knowledgeVersionId` from the gate at resume time — not the version at queue time (solution §4.8
  conversation version behavior; backend §144).
- **Partial graph:** resume MUST re-check `assertKnowledgeReadable` immediately before starting
  LangGraph; if still not `allow`, remain `queued` or fail per policy — **never** proceed (backend
  §93).
- **Ordering:** process queued messages in **`queuedAt` ascending** per project unless **§12**
  chooses fairness across conversations.

### 4.3 Resume trigger (integration with phase 28)

Two patterns are documented; **implementation picks one after approval**:

| Pattern | Pros | Cons |
|---|---|---|
| **A — Worker callback** | Immediate drain after S6; no extra poll latency | Tight coupling ingest module → chat queue |
| **B — Poll / scheduled tick** | Decoupled; reuses phase 21 scheduler | Delay until next tick; must idempotent |

Phase 28 finalize calls **`notifyKnowledgePublished(scope)`** (name TBD) exported from this
module. That function loads `processingStatus: 'queued'` messages for the project where
`expiresAt > now`, transitions each to `accepted`, and enqueues inference work through the phase
50 runner (same process, not the ingest worker — architecture §6.1).

### 4.4 Expiry and recovery exhaustion

- **`expiresAt`:** set at queue time using **`QUEUED_MESSAGE_TTL_MS`** — constant placeholder
  module only; **value comes from phase 05 evaluation** (backend §95, solution §5.6 queue wait).
  Until phase 05 exists, tests use a test-only override; production value is a **blocker**.
- **Sweeper:** phase 21 scheduler tick (or dedicated lightweight job) finds
  `queued` + `expiresAt <= now` → `failed`, `error.code = KNOWLEDGE_UNAVAILABLE`,
  `retryability = temporary` (catalog entry), user-safe message (no stack traces).
- **Recovery exhausted:** phase 28 signals **`failQueuedMessagesForProject(projectId, reason)`**
  with the same terminal shape — shared helper with expiry path.

### 4.5 Client interaction without SSE

- Initial send returns **`202`** — client uses **message GET** (phase 41/50) or conversation
  reload to observe transition (frontend §53–54). Whether a dedicated
  `GET .../messages/:id/status` is needed is **§12**; minimum is list/detail on `Message`.
- **No** long-poll SSE for queue wait (explicit product rule for this phase).
- Idempotency: **`Idempotency-Key`** on POST (phase 12) returns the same `messageId` + `jobId`
  for duplicate submits while still `queued`.

### 4.6 Audit and logging

- Audit **`chat.message_queued`** (actor, conversationId, messageId, jobId) — **not** full message
  body in audit (security standards; phase 10 patterns).
- Structured logs: `messageId`, `jobId`, `projectId`, `correlationId` — never full chat content
  at info level in production.

## 5. Data model changes

Additive on **`messages`** (phase 41); row visibility remains **`status: 'A' | 'D'`**.

| Field | When set | Notes |
|---|---|---|
| `processingStatus` | always | Add enum value **`queued`** alongside existing lifecycle values from 41/50 |
| `queuedAt` | on queue | Date |
| `expiresAt` | on queue | Date; TTL from evaluation constant |
| `blockingJobId` | on queue | ObjectId → `jobs` (writer / ingest job) |
| `knowledgeVersionId` | on resume/start | Set when FLOW B starts after publish |
| `queueFailureCode` | on expiry/exhaustion | e.g. `KNOWLEDGE_UNAVAILABLE` |

Indexes (partial `status: 'A'`):

- `{ orgId, projectId, processingStatus: 1, queuedAt: 1 }` — drain and sweeper.
- `{ orgId, projectId, blockingJobId: 1, processingStatus: 1 }` — optional job-scoped fail on
  job terminal failure (**§12** if job cancel should fail queue).

No new collection unless **§12** prefers a separate `queuedChatOperations` — default is fields on
`Message`.

## 6. API contract — PROPOSED (needs approval before implementation)

Extends phase 50 **`POST /api/v1/conversations/:conversationId/messages`**.

**Permission:** `chat.ask` (unchanged).

**When gate returns `queue`:**

- **Status:** `202 Accepted`
- **Body:**

```json
{
  "messageId": "msg_01J…",
  "jobId": "job_01J…",
  "processingStatus": "queued",
  "queuedAt": "2026-09-12T16:00:00.000Z",
  "expiresAt": "2026-09-12T16:30:00.000Z"
}
```

`expiresAt` is illustrative; offset is **not approved** until phase 05.

- **Headers:** `X-Correlation-Id`; **`Idempotency-Key`** honored (phase 12).
- **No** `Content-Type: text/event-stream` response for this branch.

**Message detail / list (phase 41):** queued messages expose `processingStatus: 'queued'`,
`blockingJobId`, `expiresAt`. On failure:

```json
{
  "processingStatus": "failed",
  "error": {
    "code": "KNOWLEDGE_UNAVAILABLE",
    "class": "system",
    "retryability": "temporary",
    "message": "Project knowledge was unavailable before your question could be answered.",
    "reference": "…"
  }
}
```

**Internal (not HTTP):**

```json
{
  "notifyKnowledgePublished": {
    "input": { "orgId": "…", "projectId": "…", "knowledgeVersionId": "…" },
    "effect": "resume unexpired queued messages for project"
  },
  "failQueuedMessagesForProject": {
    "input": { "orgId": "…", "projectId": "…", "reason": "recovery_exhausted | job_failed" },
    "effect": "terminal KNOWLEDGE_UNAVAILABLE on all queued rows"
  }
}
```

## 7. Configuration & environment variables

**None** for queue TTL — evaluation-derived duration is a **named constant** once phase 05
approves it (`.cursor/rules/env-config.mdc`). Until then, constant symbol exists with **no**
production default in `.env`.

### Constants (not env — values pending phase 05)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `QUEUED_MESSAGE_TTL_MS` | **TBD (phase 05)** | `modules/chat/chat.queue.js` | Time until queued message fails retryable |
| `QUEUED_MESSAGE_SWEEP_INTERVAL_MS` | **TBD** | `worker/scheduler` or chat module | How often to fail expired rows if not event-driven |
| `QUEUED_MESSAGE_BATCH_SIZE` | **TBD** | `modules/chat/chat.queue.js` | Max messages resumed per publish notification |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/chat/chat.queue.js` (+ `.test.js`) | **New:** queue persist, resume drain, fail expired/exhausted |
| `backend/src/modules/chat/chat.gate.js` | **Change:** wire gate `queue` branch from 28 helper (if not already in 50 handler) |
| `backend/src/modules/chat/chat.routes.js` (+ test) | **Change:** `202` branch on POST messages |
| `backend/src/modules/chat/chat.messages.repository.js` | **Change:** queued queries, status transitions |
| `backend/src/modules/chat/message.model.js` | **Change:** additive queued fields + index |
| `backend/src/modules/knowledge/knowledge.publish.js` (28) | **Change:** call `notifyKnowledgePublished` after validated publish |
| `backend/src/modules/ingest/stages/s6Finalize.js` (28) | **Change:** same hook if finalize lives here |
| `backend/src/worker/scheduler.js` | **Change:** optional expiry sweep registration |
| `backend/src/modules/audit/audit.actions.js` | **Change:** `chat.message_queued` action constant |

## 9. Tests (≥ 80% line and branch)

### Unit

- Gate `queue` → handler persists `queued`, returns `202`, does **not** invoke LangGraph or SSE.
- `notifyKnowledgePublished` selects only unexpired `queued`, ordered by `queuedAt`.
- Expired row → `failed` + `KNOWLEDGE_UNAVAILABLE` + retryable.
- `failQueuedMessagesForProject` marks all queued for project.
- Resume re-invokes gate; if `deny`, does not start tools (mock gate).
- Idempotency-Key returns same ids for duplicate POST while queued.

### Integration (Mongo harness, mocked LangGraph)

- Project `updating` + active job → POST → `202`, message row, job link.
- Simulate publish hook → message becomes `accepted` and FLOW B runner called once.
- Simulate recovery exhausted hook → queued → failed retryable.
- Cross-tenant message/conversation → `404`, no queue row.

### Unhappy paths

- Gate flips to `allow` but message already expired → fail, not run.
- Soft-deleted conversation → POST rejected; no queue.
- Concurrent publish notifications → at-most-once resume per message (idempotent transition).

## 10. Definition of Done

- [ ] `POST .../messages` returns **`202 { messageId, jobId }`** when gate queues; **no SSE**.
- [ ] Queued messages never start LangGraph while knowledge is updating/recovering or writer active.
- [ ] Unexpired queued messages resume after validated publish (tested via hook).
- [ ] Expiry and recovery exhaustion produce **retryable `KNOWLEDGE_UNAVAILABLE`** on the message.
- [ ] `Idempotency-Key` on queued POST behaves per phase 12.
- [ ] Audit logs queue event without full chat body; logs redact content.
- [ ] Row `status` remains **`A` | `D`** only; no hard delete.
- [ ] No in-app rate limiting added.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch on touched modules.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.1 step 4 and §7: confirm queued/`202` behavior matches implementation.
- `backend/solution.md` §4.8 and §5.8: no contradiction; update only if resume ordering differs
  from doc after §12 decisions.
- ADR only if resume trigger choice (callback vs poll) is contested — record coupling decision.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Queue TTL duration:** what is `QUEUED_MESSAGE_TTL_MS` after phase 05 evaluation? Until
   then, implementation is blocked for production defaults.
2. **Resume trigger:** worker callback on publish (**A**) vs scheduler poll (**B**) — which?
3. **Active `jobId` in `202`:** always the ingest/recovery job, or the latest `running` job of any
   type on the project?
4. **Ordering across conversations:** strict FIFO per project vs per-conversation drain?
5. **Failed health on POST:** when gate is `deny` (knowledge failed), is it `503`, `409`, or `422`
   — align with phase 50.
6. **Job cancelled mid-queue:** should queued messages fail immediately or stay queued until TTL?
7. **Separate collection:** keep queue state on `Message` vs dedicated queue table for indexing?
8. **Partial publish:** if health is `partially_available`, resume immediately — confirm same as
   `ready` for queue purposes.
