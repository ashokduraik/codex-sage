# Phase 50 — Chat SSE endpoint & stream lifecycle

- **Layer:** BE
- **Depends on:** Phase 12 (idempotency — no in-app rate limiting), Phase 49 (complete graph +
  stream/persist callbacks)
- **Unblocks:** Phase 51, 52, 53, 55
- **Size:** 1–2 days
- **Requirements covered:** backend §65, §96, §119, §120; backend/solution.md §5.1; docs/architecture.md
  §6.1, §9 (SSE event list), §10 (idempotency)

## 1. Goal

After this phase clients can
**`POST /api/v1/projects/:projectId/conversations/:conversationId/messages`** with
**`Accept: text/event-stream`**, permission **`chat.ask`**, and project ACL to receive a grounded
answer stream. The handler enforces the knowledge gate (`ready` / `partially_available` → SSE;
`failed` / unreadable → `KNOWLEDGE_UNAVAILABLE`; updating → `KNOWLEDGE_UPDATING` JSON until phase
51). It saves the user + pending assistant messages, runs the phase 47–49 LangGraph in the **API
process**, maps graph hooks to SSE events (`status`, `delta`, `clarification`, `evidence`, `done`,
`error`), and honours **`Idempotency-Key`**. On client disconnect the run **continues** until
persist completes; the UI reloads the assistant message by id.

## 2. Why this phase is here

The graph (47–49) needs an HTTP transport. Architecture §6.1 places SSE on the chat POST in the
API process. Phase 12 prevents duplicate runs on retries. Queued questions (51) and clarification
POST (52) need this happy-path stream first.

## 3. Scope

### In scope

- Route under `/api/v1/projects/:projectId/conversations/:conversationId/messages`.
- Auth: JWT → org, user; **`chat.ask`** + project membership.
- Load conversation `status: 'A'`, owner-scoped; reject cross-tenant / cross-owner as
  `CONVERSATION_NOT_FOUND`.
- Knowledge gate via `assertKnowledgeReadable`:
  - `allow` → SSE
  - `deny` → JSON `KNOWLEDGE_UNAVAILABLE` (no message persist)
  - `queue` → JSON `KNOWLEDGE_UPDATING` (no SSE, no persist; phase 51 owns 202 + queued rows)
- Insert user (`accepted`) + assistant (`generating`) in one transaction.
- **`Idempotency-Key` required**; completion stores JSON outcome; replay returns that JSON (no second
  graph run / no SSE replay).
- Require `Accept` containing `text/event-stream`; else `NOT_ACCEPTABLE` (406).
- Open SSE; emit `status` `{ stage: 'accepted', knowledgeHealth }`; wire graph hooks to SSE.
- Clarification interrupt → `clarification` event; assistant `awaiting_clarification`; stream ends;
  resume is phase 52.
- Terminal `done` / `error` via `buildStreamErrorEvent`.
- Disconnect: stop SSE writes; **do not** abort the graph.
- Correlation id on responses and SSE `error.reference`.
- `buildStreamErrorEvent` in `platform/streamErrors.js` (phase 02 deferred here).

### Out of scope (owner phase)

- Queued message persistence / 202 — **phase 51**.
- Clarification answers POST — **phase 52**.
- Message edit / retry / cancel-on-disconnect — **phase 53**.
- Frontend EventSource — **phase 55**.
- Ask-about-this body fields — later phase; body is `{ content }` only.
- In-app rate limiting — none.
- Worker execution of chat — forbidden.

## 4. Design

### 4.1 Request flow

```text
POST /api/v1/projects/:projectId/conversations/:conversationId/messages
Headers: Authorization, Accept: text/event-stream, Idempotency-Key
Body: { content: string }

1. Auth + chat.ask + project ACL
2. Accept check → NOT_ACCEPTABLE if missing text/event-stream
3. Idempotency claim (phase 12); replay JSON if completed
4. Load conversation (writable) + assertKnowledgeReadable
5. deny → KNOWLEDGE_UNAVAILABLE; queue → KNOWLEDGE_UPDATING
6. Insert user + assistant messages
7. SSE headers; status accepted; keepalive comments
8. invokeChatGraph with writeSse hooks (writes no-op after disconnect)
9. Interrupt → clarification event; awaiting_clarification; complete idempotency; end
10. Complete → evidence/done already from persist hooks; complete idempotency
11. Error → SSE error frame; complete idempotency with failed
```

### 4.2 SSE envelope

| Event | When | Data |
|-------|------|------|
| `status` | Stage changes | `{ stage: string, knowledgeHealth?: string }` |
| `delta` | Draft tokens | `{ text: string }` |
| `clarification` | Graph interrupt | `{ clarificationSetId, questions: [...] }` |
| `evidence` | Before done | `{ items: EvidenceRecord[] }` |
| `done` | Success | `{ messageId: string }` |
| `error` | Terminal failure | `{ code, class, retryability, message, reference }` |

Allowed stages include: `accepted`, `understanding_question`, `searching_code`,
`reviewing_sources`, `generating_answer`, `verifying_answer`, `awaiting_clarification`,
`abstain_early`. No chain-of-thought. No database-query stages.

### 4.3 Handler owns `reply`

`runChatMessageStream` receives `writeSse` / `isClientConnected` — never `reply`. The route
handler owns `reply.raw`.

### 4.4 Idempotency

Stored completion body:

```json
{
  "userMessageId": "…",
  "assistantMessageId": "…",
  "messageStatus": "completed|abstained|failed|awaiting_clarification"
}
```

Replay: **200** JSON (not SSE). Stream path completes the claim explicitly so `onSend` does not
mis-store a raw stream payload.

### 4.5 Disconnect

`request.raw.on('close')` → `clientConnected = false`; `writeSse` no-ops; graph continues.
Final `messageStatus` comes from persist (`completed` / `abstained` / `failed` /
`awaiting_clarification`). Do **not** set `interrupted` on disconnect alone.

### 4.6 Keepalive

SSE comment lines (`: keepalive\n\n`) every `SSE_KEEPALIVE_INTERVAL_MS` while the stream is open.

## 5. Schema changes (needs explicit user approval before model code)

**Collection purpose:** `messages` stores each chat turn. Phase 50 needs non-terminal statuses so
the UI can reload a mid-run or clarify-paused assistant (§119–§120).

**Collection / model:** `messages` / `Message`

| Field | Change | Purpose |
| --- | --- | --- |
| `messageStatus` enum | Expand to `accepted\|generating\|awaiting_clarification\|completed\|abstained\|failed\|interrupted` | User accepted; assistant in flight; clarify pause; terminals; `interrupted` reserved for cancel/crash |

**Indexes:** none new.

**Out of scope:** `queued` and queue job fields — phase 51.

**Approval gate:** model edits wait for an explicit yes to this exact list in the implementing
conversation.

## 6. API contract

### `POST /api/v1/projects/:projectId/conversations/:conversationId/messages`

| | |
|---|---|
| **Permission** | `chat.ask` + project membership |
| **Headers** | `Authorization`, `Accept: text/event-stream`, `Idempotency-Key` (required) |
| **Body** | `{ "content": "string" }` (required, max length constant) |
| **Success** | `200` `Content-Type: text/event-stream` ending in `done`, `clarification`, or `error` |
| **Idempotent replay** | `200` `application/json` with stored message ids + `messageStatus` |

**Errors (JSON, before SSE headers):**

| Code | When |
|------|------|
| `NOT_ACCEPTABLE` | Accept does not include `text/event-stream` |
| `KNOWLEDGE_UNAVAILABLE` | Gate deny |
| `KNOWLEDGE_UPDATING` | Gate queue (phase 51 will replace with 202) |
| `CONTEXT_ACCOUNTING_UNAVAILABLE` | Budgeter fail closed (may also be mid-stream SSE error) |
| `VALIDATION_ERROR` | Missing/invalid content |
| `CONVERSATION_NOT_FOUND` | Missing / wrong tenant / not owner |
| `FORBIDDEN` | Missing `chat.ask` |

Mid-stream failures → SSE `error` only.

## 7. Configuration & environment variables

**None.** `CHAT_MESSAGE_CONTENT_MAX_LENGTH`, `SSE_KEEPALIVE_INTERVAL_MS` are named constants in
`chatStream.js`.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/conversation/chatStream.js` | POST SSE route + orchestration |
| `backend/src/modules/conversation/conversation.helper.js` | `insertChatTurnPair` |
| `backend/src/modules/conversation/index.js` | Export routes |
| `backend/src/http/routes.js` | Register `chatStreamRoutes` |
| `backend/src/platform/streamErrors.js` | `buildStreamErrorEvent` |
| `backend/src/platform/errorCatalog.js` | `NOT_ACCEPTABLE` |
| `backend/src/models/messages.model.js` | Enum expand (after approval) |
| `docs/architecture.md` | Project-scoped path §6.1 |
| `docs/data-model.md` | Enum sync (after approval) |

Do **not** add `backend/src/modules/chat/`.

## 9. Tests (≥ 80% line and branch)

- Unit: SSE formatter; `buildStreamErrorEvent`; gate branches; disconnect suppresses writes.
- Integration: happy path `status`→`done`; 403 without `chat.ask`; 404 wrong conversation;
  406 Accept; mid-stream SSE `error` with matching `reference`; clarification interrupt;
  idempotent JSON replay without second graph invoke; updating → `KNOWLEDGE_UPDATING`.

## 10. Definition of Done

- [ ] Project-scoped POST messages SSE path live.
- [ ] `chat.ask`, project ACL, tenant/owner scope enforced.
- [ ] Knowledge gate allow / deny / queue as locked above.
- [ ] Six SSE event types only.
- [ ] Idempotency-Key required; JSON replay on duplicate.
- [ ] Disconnect continues graph; message recoverable by id.
- [ ] Handler owns reply; services never take `reply`.
- [ ] LangGraph in API process, not worker.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch on touched code.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.1 path + §9 event list.
- `docs/data-model.md` `messageStatus` enum (with schema approval).
- Frontend / phase 55 consumes this contract (no FE code in this phase).

## 12. Locked decisions (no open options)

1. Updating gate → `KNOWLEDGE_UPDATING` JSON (not 501/202 stub).
2. Idempotent replay → JSON pointing at message ids (not re-opened SSE).
3. Accept must include `text/event-stream` → else `NOT_ACCEPTABLE`.
4. Disconnect → continue run; no cancel-on-disconnect in this phase.
5. SSE comment keepalive via named constant.
6. Body is `{ content }` only (no ask-about-this fields).
