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
`messageStatus`, returns **`202 Accepted`** with `{ messageId, jobId, … }`, and **does not** open
a waiting event stream. When phase 28 publishes a validated graph (`ready` or `partially_available`),
unexpired queued messages are resumed against the **new current** graph only — never against a
partially mutated index. If queue wait expires, the blocking writer job is cancelled/failed, or
bounded recovery is exhausted, each affected message becomes **`failed`** with retryable
`KNOWLEDGE_UNAVAILABLE` the UI can offer to resend (frontend §63, backend §95).

You can see it working by starting a re-ingest, POSTing a chat message, receiving `202` with ids,
watching the message row stay `queued` linked to the active writer job, then — after ingest
completes — seeing the message transition to `accepted` and FLOW B run headless (or fail retryable
if the queue expired during a long recovery).

## 2. Why this phase is here

Phase 28 defines **`assertKnowledgeReadable`** and returns `action: 'queue'` when health or an
active graph writer forbids Q&A, but it does not persist queued messages, tie them to the blocking
job, resume them after publish, or fail them on expiry — that is this phase. Phase 50 owns the
happy-path SSE send when the gate returns `allow`; without 51, step 4 in architecture §6.1 would
either reject users during every ingest or incorrectly stream answers against stale or mutating
graphs (backend §93–§94, solution §4.8 hard rule on concurrency with chat).

## 3. Scope

### In scope

- Extend phase 50 `streamConversationMessageHttp` / `runChatMessageStream`: when the gate returns
  `queue`, persist and return `202` — **no SSE body**, no LangGraph start.
- **`queued` message lifecycle** on `Message`: linkage to the active ingest/recovery/repo_sync
  **`blockingJobId`**, `queuedAt`, `expiresAt`, optional `queueFailureCode` on terminal failure.
- **Resume path** after successful S6 publish via **`notifyKnowledgePublished`** (worker callback).
- **Failure path** when recovery exhausts, writer job cancels/fails, or **`expiresAt`** passes.
- **Expiry sweeper** on the worker so expired rows fail without a client connection.
- Guarantee: **never** start UNDERSTAND/tools against a graph while `assertKnowledgeReadable`
  would return `queue` or `deny`.

### Out of scope (owner phase)

- Gate health enum mapping and recovery job shape — **phase 28**.
- SSE event types, stream lifecycle — **phase 50** (extended, not replaced).
- Clarification POST — **phase 52**.
- Message edit / assistant retry — **phase 53**.
- Frontend queued indicator and poll UX — **phase 55**.
- In-app rate limiting — out of product scope.

## 4. Locked decisions

| Decision | Choice |
| --- | --- |
| Resume after publish | **A — callback**: S6 finalize calls `notifyKnowledgePublished` |
| Queue TTL | `QUEUED_MESSAGE_TTL_MS = 1_800_000` (30 min); phase 05 may re-measure later |
| Job cancel / writer fail | Fail all project queued messages immediately (`KNOWLEDGE_UNAVAILABLE`, temporary) |
| Drain order | FIFO by `queuedAt` **project-wide** |
| `jobId` in 202 | Writer job only (`ingest` / `reingest` / `repo_sync`); else `null` |
| Deny on POST | 503 `KNOWLEDGE_UNAVAILABLE`, no Message row |
| Partial publish | Same as `ready` (gate already `allow` for `partially_available`) |
| Storage | Fields on `messages` (no new collection) |
| Status field | `messageStatus` (not `processingStatus`) |
| Module | `conversation` only |

### 4.1 Decision flow on POST

```text
POST …/conversation/chatStream/streamMessage/:projectId/:conversationId
  auth: chat.ask + project membership + conversation scope
  gate = assertKnowledgeReadable(project)

  if gate.action === 'deny'
    → 503 KNOWLEDGE_UNAVAILABLE — no Message row

  if gate.action === 'queue'
    → Accept: text/event-stream NOT required
    → persist Message { role: user, messageStatus: 'queued', … }
    → 202 { messageId, jobId, messageStatus, queuedAt, expiresAt }  STOP

  if gate.action === 'allow'
    → require Accept: text/event-stream
    → existing phase 50 path (accepted → SSE → LangGraph)
```

### 4.2 State machine

```text
queued → accepted / generating → completed | failed | awaiting_clarification | abstained
     ↘ failed (expiry | job cancel/fail | recovery exhausted)
```

Resume re-checks `assertKnowledgeReadable` immediately before LangGraph. Process FIFO by
`queuedAt` ascending per project. Headless resume runs in the **worker** (S6 caller).

### 4.3 Client interaction

- Initial send returns **202** — client uses message list/detail to observe transition.
- **No** long-poll SSE for queue wait.
- **`Idempotency-Key`** returns the same `messageId` + `jobId` while still `queued`.

## 5. Data model changes

Additive on **`messages`**. Row visibility remains **`status: 'A' | 'D'`**.

| Field | Type | Notes |
| --- | --- | --- |
| `messageStatus` | enum + `queued` | Alongside existing lifecycle values |
| `queuedAt` | Date | Set on queue |
| `expiresAt` | Date | `queuedAt + QUEUED_MESSAGE_TTL_MS` |
| `blockingJobId` | ObjectId → Job | Writer job when known |
| `queueFailureCode` | String | e.g. `KNOWLEDGE_UNAVAILABLE` on fail |
| `knowledgeVersionId` | existing | Set when FLOW B starts after publish |

Indexes (partial `status: 'A'`):

- `{ orgId, projectId, messageStatus, queuedAt }` — drain and sweeper
- `{ orgId, projectId, blockingJobId, messageStatus }` — job-scoped / project fail

**Schema approval required** before model edits (`schema-change-approval.mdc`).

## 6. API contract

Extends phase 50 POST. **Permission:** `chat.ask`.

**When gate returns `queue`:**

- **Status:** `202 Accepted`
- **Body:**

```json
{
  "messageId": "…",
  "jobId": "…" ,
  "messageStatus": "queued",
  "queuedAt": "2026-09-12T16:00:00.000Z",
  "expiresAt": "2026-09-12T16:30:00.000Z"
}
```

**Message detail / list:** expose `messageStatus`, `blockingJobId`, `queuedAt`, `expiresAt`. On
queue failure, DTO includes catalog-shaped `error` from `queueFailureCode`.

**Internal (not HTTP):**

- `notifyKnowledgePublished({ orgId, projectId, knowledgeVersionId })`
- `failQueuedMessagesForProject({ orgId, projectId, reason })`
- `sweepExpiredQueuedMessages()`

## 7. Configuration & constants

**None** in `.env`.

| Constant | Value | Where |
| --- | --- | --- |
| `QUEUED_MESSAGE_TTL_MS` | `1_800_000` | `modules/conversation/chatQueue.js` |
| `QUEUED_MESSAGE_SWEEP_INTERVAL_MS` | `60_000` | `chatQueue.js` / worker boot |
| `QUEUED_MESSAGE_BATCH_SIZE` | `20` | `chatQueue.js` |

## 8. Files to create or change

| Path | Purpose |
| --- | --- |
| `backend/src/modules/conversation/chatQueue.js` | Queue persist, resume drain, fail, sweep |
| `backend/src/modules/conversation/chatStream.js` | `202` branch on gate `queue` |
| `backend/src/modules/conversation/conversation.helper.js` | Queued insert / claim / fail queries |
| `backend/src/modules/conversation/conversation.js` | `mapMessageToDto` queue + error fields |
| `backend/src/modules/conversation/index.js` | Export notify / fail / sweep |
| `backend/src/models/messages.model.js` | Additive fields + indexes (after approval) |
| `backend/src/modules/knowledge/ingest.helper.js` | S6 → `notifyKnowledgePublished` |
| Ingest/knowledge fail + worker job cancel/fail | `failQueuedMessagesForProject` |
| `backend/src/worker/schedule.js` | Expiry sweep registration (queued-message tick) |
| `backend/src/modules/access/audit.js` | `chat.message_queued` |

## 9. Tests (≥ 80% line and branch)

- Gate `queue` → `202`, row `queued`, no LangGraph/SSE; Accept not required.
- Gate `deny` → 503, no row.
- Idempotency replay while queued → same ids.
- `notifyKnowledgePublished` FIFO, skips expired, re-checks gate, at-most-once claim.
- Expiry sweep / job cancel / failed health → failed + retryable `KNOWLEDGE_UNAVAILABLE`.
- Soft-deleted / cross-tenant → no queue row.

## 10. Definition of Done

- [ ] POST returns **202** when gate queues; **no SSE**.
- [ ] Queued messages never start LangGraph while knowledge is updating/recovering.
- [ ] Unexpired queued messages resume after validated publish (S6 callback).
- [ ] Expiry, job cancel/fail, and recovery exhaustion produce retryable `KNOWLEDGE_UNAVAILABLE`.
- [ ] Idempotency-Key on queued POST behaves per phase 12.
- [ ] Audit logs queue event without full chat body.
- [ ] Row `status` remains **A | D** only.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% on touched modules.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.1 step 4 / §7 — confirm match (already describes 202 queued).
- `docs/data-model.md` — new message fields/indexes in the same change as the model.
- `backend/solution.md` — only if wording disagrees with FIFO/callback (locked here).
- No ADR — resume callback coupling is locked in this phase.
