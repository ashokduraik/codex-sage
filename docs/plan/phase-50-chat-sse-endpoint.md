# Phase 50 — Chat SSE endpoint & stream lifecycle

- **Layer:** BE
- **Depends on:** Phase 12 (idempotency — no in-app rate limiting), Phase 49 (complete graph +
  stream/persist callbacks)
- **Unblocks:** Phase 51, 52, 53, 55
- **Size:** 1–2 days
- **Requirements covered:** backend §65, §96, §119, §120; backend/solution.md §5.1; docs/architecture.md
  §6.1, §9 (SSE event list), §10 (idempotency)

## 1. Goal

After this phase clients can **`POST /api/v1/conversations/:conversationId/messages`** with
**`Accept: text/event-stream`**, permission **`chat.ask`**, and project ACL to receive a grounded
answer stream. The handler enforces the **knowledge gate** (ready/partial → SSE; failed → structured
error; updating/recovering → **mention** queued 202 behaviour owned by **phase 51** but do not
implement queue persistence or 202 body details here). The handler saves the user message, starts the
phase 47–49 LangGraph run **in the API process**, maps graph hooks to SSE events
(`status`, `delta`, `clarification`, `evidence`, `done`, `error` — architecture §9), and honours
**`Idempotency-Key`** on message create (phase 12). If the client **disconnects**, the run **continues**
until persist completes; the UI reloads the assistant message by id (backend §96, §119, solution §5.8).
You can see it working with `curl -N` or an integration test: stream shows stage statuses and deltas,
terminal `done` with `messageId`, or `error` with correlation id from phase 02.

## 2. Why this phase is here

The graph (47–49) is useless to the frontend without a transport. Architecture §6.1 places SSE on the
chat POST in the **API process** — not the worker — so this phase is the boundary React (55) consumes.
It depends on 49 so every stream terminates with persisted state. It depends on 12 so duplicate POSTs
from retries do not spawn duplicate runs. Queued questions during index updates (51) and clarification
POST (52) need a live stream path first for the happy path.

## 3. Scope

### In scope

- Route registration under `/api/v1` (phase 4 ADR prefix).
- Auth: JWT → org, user; **`chat.ask`** + project membership (phase 18).
- Load conversation `status: 'A'`, tenant-scoped; reject cross-tenant ids (ADR 0014 style 404).
- **Knowledge gate** (phase 28 helper): `ready` / `partially_available` → proceed with SSE;
  `failed` → persist user message or reject per PROPOSED policy → `KNOWLEDGE_UNAVAILABLE`; 
  `updating` / recovering → **stop before SSE** with note that **phase 51** implements
  `202 { messageId, jobId }` + queued message — in 50 either return **501/503 with catalog code**
  or minimal stub that documents the handoff (**do not** implement queue job wiring here).
- Create user message (`accepted` or equivalent status from phase 41).
- **`Idempotency-Key`**: duplicate key returns same stream outcome / same message ids without second
  graph run (phase 12 store).
- Open SSE response; emit initial `status` `{ stage: 'accepted', knowledgeHealth? }` (solution §5.1).
- Invoke compiled graph with phase 49 callbacks wired to SSE writer.
- **`clarification` event:** full question list payload when graph interrupts (shape from phase 47);
  resume is **not** this phase — 52 POST resumes checkpoint.
- Terminal frames: `done`, or `error` via `buildStreamErrorEvent` (phase 02) with catalog fields.
- **Disconnect:** detect aborted request; stop forwarding deltas to client; **do not abort** graph
  unless product requires cancel-on-disconnect — architecture says run finishes in Mongo (default:
  continue run).
- **Stream interruption semantics** (backend §120): persisted message reflects completed vs
  interrupted/failed for UI reload.
- Correlation id on all responses and error events.

### Out of scope (owner phase)

- Queued message persistence, expiry, resume after publish — **phase 51**.
- `POST .../clarifications/.../answers` — **phase 52**.
- Message edit / retry routes — **phase 53**.
- Frontend EventSource — **phase 55**.
- In-app rate limiting — none (architecture §10, phase 12).
- Worker execution of chat — forbidden for this flow.

## 4. Design

### 4.1 Request flow

```text
POST /api/v1/conversations/:conversationId/messages
Headers: Authorization, Accept: text/event-stream, Idempotency-Key?
Body: { content: string, ... optional ask-about-this refs from 38 — PROPOSED }

1. Auth + chat.ask + project ACL
2. Idempotency lookup → short-circuit if completed run exists
3. Load project knowledge health + gate
4. If updating/recovering → defer to phase 51 (see §3)
5. Insert user Message
6. Set SSE headers; emit status accepted
7. Build runContext + compile graph invoke
8. Map hooks → SSE events until done/error/interrupt
9. On interrupt (clarification): emit clarification event; close stream; persist awaiting state
10. On complete: emit evidence (if not already), done, end stream
11. Idempotency record completion
```

LangGraph runs synchronously on the request async handler **until** interrupt or completion — still
non-blocking for **ingest** (worker rule applies to heavy ingest, not this architecture decision).

### 4.2 SSE envelope

Use standard SSE: `event:` + `data:` JSON lines. Event names **exactly**:

| Event | When | Data (minimal PROPOSED) |
|-------|------|-------------------------|
| `status` | Stage changes | `{ stage: string, knowledgeHealth?: string }` |
| `delta` | Draft tokens | `{ text: string }` |
| `clarification` | CLARIFY_SET | `{ clarificationSetId, questions: [...] }` |
| `evidence` | Before done | `{ items: EvidenceRecord[] }` |
| `done` | Success | `{ messageId: string }` |
| `error` | Terminal failure | phase 02 five-field object |

Allowed `stage` values include those from backend §66 that map to real operations:
`understanding_question`, `searching_code`, `reviewing_sources`, `generating_answer`,
`verifying_answer`, `accepted`. **No** chain-of-thought fields (backend §67).

Database-query stages (§66 examples) are **out of scope** — do not emit.

### 4.3 Handler owns `reply`

`chatStream.service.js` returns an async iterator or runs with injected `writeSse(event, data)` —
the **route handler** calls Fastify `reply.raw` / `@fastify/sse` (if adopted) — helpers never take
`reply` (workspace rule). Service throws; handler maps to SSE `error` if headers not sent, else JSON
error envelope.

### 4.4 Idempotency

Scope key: org + user + conversation + idempotency key + route (phase 12). Stored outcome:

- `messageId`, `assistantMessageId?`, `status: completed | failed | awaiting_clarification`
- Replay: if completed, return **200** with SSE that immediately sends `done` **or** JSON pointing
  client to GET message — **open question** §12 (PROPOSED: non-stream JSON replay for idempotent
  retry).

### 4.5 Knowledge gate (partial implementation)

| Health | Phase 50 behaviour |
|--------|-------------------|
| ready / partially_available | SSE run |
| failed | No SSE; JSON error `KNOWLEDGE_UNAVAILABLE` (retryability temporary) |
| updating / recovering | **Not in scope:** document handoff to 51; return structured response placeholder agreed in §6 |

### 4.6 Disconnect and recovery

- Register `request.raw.on('close')` → set flag; stop `writeSse`; graph continues (architecture §6.1).
- Phase 49 persist sets `messageStatus` so GET message shows completed/failed/interrupted (§119).
- No indefinitely `generating` without lease timeout — optional sweeper **open** (62).

## 5. Data model changes

**None** required if phase 41 messages and phase 12 idempotency records exist. May add
`assistantMessageId` on idempotency payload — PROPOSED.

## 6. API contract — PROPOSED (needs approval before implementation)

### `POST /api/v1/conversations/:conversationId/messages`

| | |
|---|---|
| **Permission** | `chat.ask` + project membership |
| **Headers** | `Authorization: Bearer …`, `Accept: text/event-stream`, optional `Idempotency-Key` |
| **Body** | `{ "content": "string (required, max length constant)" }` |
| **Success** | `200`/`201` with `Content-Type: text/event-stream` — event sequence ending in `done` or `error` |
| **Clarification interrupt** | Stream ends after `clarification` event; message `awaiting_clarification` |

**Knowledge updating (phase 51 — not implemented in 50):**

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "messageId": "…", "jobId": "…", "status": "queued" }
```

Phase 50 doc **references** this shape; implementation waits for 51.

**Errors (JSON, before SSE headers):**

| Code | When |
|------|------|
| `KNOWLEDGE_UNAVAILABLE` | Graph failed / unreadable |
| `CONTEXT_ACCOUNTING_UNAVAILABLE` | Budgeter fail closed |
| `VALIDATION_ERROR` | Missing content |
| `FORBIDDEN` / `NOT_FOUND` | ACL / tenant |

Mid-stream failures → SSE `error` event only (phase 02).

### SSE example (illustrative)

```text
event: status
data: {"stage":"accepted","knowledgeHealth":"ready"}

event: status
data: {"stage":"understanding_question"}

event: delta
data: {"text":"Checkout "}

event: evidence
data: {"items":[...]}

event: done
data: {"messageId":"507f1f77bcf86cd799439011"}
```

## 7. Configuration & environment variables

**None.** Max message body length, SSE heartbeat interval (if any) — named constants in chat routes
module. No rate-limit env vars.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/chat/chat.routes.js` (+ `.test.js`) | POST messages SSE route |
| `backend/src/modules/chat/chatStream.service.js` (+ `.test.js`) | Gate, idempotency, graph invoke |
| `backend/src/modules/chat/sse/sseWriter.js` (+ `.test.js`) | Pure SSE framing |
| `backend/src/modules/chat/sse/sseEventMap.js` (+ `.test.js`) | Hook → event mapping |
| `backend/src/http/routes.js` | Register chat routes |
| `backend/src/modules/knowledge/` (28) | `assertKnowledgeReadable` / health gate |
| `backend/src/modules/idempotency/` (12) | Message create idempotency |
| `backend/src/platform/streamErrors.js` (02) | Terminal error payload |
| `backend/src/modules/chat/graph/chatGraph.js` (47–49) | Invoke entry |

## 9. Tests (≥ 80% line and branch)

### Unit

- sseWriter formats event lines; no CoT fields in mapped payloads.
- Gate: ready → invoke graph; failed → throws KNOWLEDGE_UNAVAILABLE without graph.
- Idempotency: second call same key does not double-invoke graph mock.
- Disconnect flag stops writes; graph mock still completes persist callback.

### Integration (`app.inject` or supertest with stream consumer)

- Authorized POST → receives `status` then `done` with valid messageId in Mongo.
- Missing `chat.ask` → 403 JSON, no SSE.
- Wrong org conversation → 404.
- Mid-stream provider error → `error` event with `reference` matching header.
- Clarification interrupt → `clarification` event; stream ends; message status awaiting.

### Unhappy paths

- Accept header not event-stream → **406 or JSON fallback** — open question §12.
- Headers already sent then throw → no second HTTP response.
- Partial knowledge: `knowledgeHealth` in first status event.

## 10. Definition of Done

- [ ] POST route live at `/api/v1/conversations/:id/messages` with SSE accept path.
- [ ] `chat.ask`, project ACL, tenant scope enforced.
- [ ] Knowledge gate for ready/partial/failed; updating path documented for 51, not fully implemented.
- [ ] Six SSE event types only (`status`, `delta`, `clarification`, `evidence`, `done`, `error`).
- [ ] Idempotency-Key on message create wired to phase 12.
- [ ] Disconnect continues graph run; message recoverable by id (§96, §119).
- [ ] No in-app rate limiting added.
- [ ] Handler owns reply; services return data/throw only.
- [ ] LangGraph runs in API process, not worker.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.1: confirm step numbering matches handler.
- `docs/architecture.md` §9 SSE list matches implementation.
- Frontend requirements cross-link when PROPOSED contract approved.

## 12. Risks & open questions

1. **Updating/recovering gate in 50:** return 501, 503, or temporary 202 stub until 51 ships?
2. **Idempotent replay:** re-open SSE stream vs JSON pointing to GET message?
3. **Accept header mandatory** or negotiate JSON async job response for non-browser clients?
4. **Cancel on disconnect:** architecture default continue — confirm no stop button requirement in 53
   for in-flight generation.
5. **SSE heartbeat / proxy timeouts** — constant keep-alive needed for local dev only?
6. **Ask-about-this** body fields from phase 38 — include in POST schema now or later phase?
