# Phase 52 — Clarification API: set delivery, answers & resume

- **Layer:** BE
- **Depends on:** Phase 47 (LangGraph `CLARIFY_SET` interrupt, checkpoint shape, max one follow-up
  set), Phase 50 (SSE `clarification` event with full question list, message persistence)
- **Unblocks:** Phase 56 (frontend clarification slice)
- **Size:** 1–2 days
- **Requirements covered:** backend §53–§55; solution §5.4, §5.6, §5.8; architecture §6.2
  CLARIFY_SET; frontend §47–§52 (one-at-a-time UI only — not implemented here)

## 1. Goal

After this phase, when FLOW B pauses at **`CLARIFY_SET`**, the backend persists a **clarification
set** (all questions the model emitted in one batch), exposes it on the message for reload, and
accepts **one HTTP POST** carrying **all answers** at once. Submitting answers **resumes** the
LangGraph checkpoint once with the full answer map. The product allows **at most one initial set
plus one follow-up set** (solution §5.6); a third set is rejected. If the user never submits,
the message remains **`awaiting_clarification`** and is resumable (solution §5.8). The UI showing
questions one-at-a-time is **frontend-only** (phase 56); the API never requires per-question
round-trips after the set is issued (backend §54).

You can see it working by triggering a clarifying question via chat SSE, receiving the full list in
the stream, POSTing all answers to the proposed route, and watching the same message continue to
`completed` with a grounded answer — or stay `awaiting_clarification` until answers arrive after
refresh.

## 2. Why this phase is here

Phase 47 defines the graph interrupt and structured question JSON; phase 50 streams the **`clarification`**
SSE payload but cannot accept answers or resume — that would block the browser on a half-open stream.
Requirements §54–§55 require persisted clarification state across navigation and refresh, and §5.4
fixes the contract: LLM emits the **full set**, UI collects locally, API receives **one payload**.
Without this phase, clarifications are ephemeral stream data and FLOW B cannot continue.

It depends on 47 for checkpoint ids and resume API, and 50 for the message row and SSE envelope.
It must precede phase 56 so the frontend wires to a stable POST contract.

## 3. Scope

### In scope

- **`ClarificationSet`** persistence linked to a **`Message`** (user question being answered).
- Fields for each question: `id`, `type` (`single_select` | `multi_select` | `free_text`),
  `prompt`, options (for select types), `required`.
- **`round`:** `1` or `2` (initial vs follow-up); enforce max two sets per message run.
- Message **`processingStatus`:** `awaiting_clarification` while a set is open; transition on
  answer POST or terminal graph outcome.
- **PROPOSED** `POST .../messages/:messageId/clarifications/:clarificationId/answers` with full
  answer map; validate types; resume LangGraph once.
- Idempotent answer POST where appropriate (duplicate submit returns same outcome — **§12**).
- Abandoned clarification: no timeout requirement in MVP beyond user leaving — message stays
  **`awaiting_clarification`** (solution §5.8).
- Authorization: same as chat send — **`chat.ask`** + conversation/project scope; author must
  match conversation access (not necessarily message author for assistant row — user message parent).

### Out of scope (owner phase)

- UNDERSTAND prompt and JSON schema — **phase 47**.
- SSE event wiring and first `clarification` emit — **phase 50**.
- One-at-a-time UI, local draft answers — **phase 56**.
- Pinned facts from clarifications into long-term context — **phase 44** (may read answers later).
- In-app rate limiting — **out of scope** (phase 12).
- Full chat transcript in audit — log **`chat.clarification_answered`** with ids only.

## 4. Design

### 4.1 Lifecycle

```text
User POST message → SSE … → CLARIFY_SET interrupt
  → persist ClarificationSet (round 1, status open)
  → Message.processingStatus = awaiting_clarification
  → SSE clarification { clarificationId, questions[] }  (50)

User POST answers (this phase)
  → validate all required questions answered
  → persist answers on set; status answered
  → resume LangGraph checkpoint with answerMap
  → either completed | failed | CLARIFY_SET round 2 | awaiting again

Abandoned: no POST → message stays awaiting_clarification indefinitely (MVP)
```

### 4.2 Question types (backend §53)

| Type | Answer shape | Validation |
|---|---|---|
| `single_select` | `{ optionId }` | Must be one of `options[].id` |
| `multi_select` | `{ optionIds: [] }` | Non-empty subset of options |
| `free_text` | `{ text }` | Trimmed, max length constant **TBD (evaluation)** |

Malformed answers → `400 VALIDATION_ERROR` with field-level `details`; do not partial-resume.

### 4.3 Round cap (solution §5.6)

```text
round 1 answered → graph continues
  if second CLARIFY_SET → persist round 2, new clarificationId, SSE again (50)
  if third CLARIFY_SET attempted → graph abstains or fails with structured code — §12
```

API rejects creating a third open set on the same message run.

### 4.4 Resume integration

```text
POST answers
  load Message + ClarificationSet (status A, open)
  assert processingStatus === awaiting_clarification
  assert clarificationId matches open set
  merge answers into checkpoint payload (phase 47 Mongo checkpointer)
  invoke graph.resume(threadId, { clarificationAnswers: answerMap })
  stream further SSE on same connection?  ← NO: POST is separate; client opens new SSE or polls
```

**§12:** after answers, does the client **re-POST** for SSE continuation or use
`GET .../messages/:id/stream` — phase 50 may define **second SSE** or **poll until completed**.
This phase implements resume in-process and updates message status; transport after POST aligns
with 50.

### 4.5 Persistence for refresh (backend §55)

- Open set stored on message load: `clarification: { clarificationId, round, questions, answers? }`.
- Partial UI progress (answered Q1 locally, not submitted) is **frontend**; backend only knows
  submitted sets.
- Soft delete: sets use row **`status: 'A' | 'D'`**; superseded round closed with `status: 'D'`
  when round 2 opens.

### 4.6 Failure and abstain

- Graph resume errors → message `failed`, SSE `error` if stream active, catalog code + correlation id.
- User closes browser: graph may stay interrupted; message **`awaiting_clarification`** until POST.

## 5. Data model changes

### `clarificationSets` (new collection) — or embedded subdoc on `messages` (**§12**)

Preferred: **separate collection** for indexing and history.

| Field | Notes |
|---|---|
| Base | `orgId`, `projectId`, `status: 'A' \| 'D'`, timestamps, actors |
| `conversationId`, `messageId` | ObjectIds — message is the user question being processed |
| `clarificationId` | Public id (ulid/string) for URL |
| `round` | `1` \| `2` |
| `setStatus` | `open` \| `answered` \| `superseded` |
| `questions` | Array of typed question defs (no secrets) |
| `answers` | Map questionId → answer object; null until POST |
| `langGraphThreadId` | Checkpoint correlation (phase 47) |

Indexes (partial `status: 'A'`):

- `{ orgId, messageId, setStatus: 1 }` — at most one `open` per message (enforce in service).
- `{ orgId, clarificationId: 1 }` unique — URL lookup.

**`messages`:** ensure `processingStatus` includes **`awaiting_clarification`**.

## 6. API contract — PROPOSED (needs approval before implementation)

### `POST /api/v1/projects/:projectId/conversations/:conversationId/messages/:messageId/clarifications/:clarificationId/answers`

**Permission:** `chat.ask`; caller must have access to conversation; project membership enforced.

**Request:**

```json
{
  "answers": {
    "q1": { "optionId": "opt_a" },
    "q2": { "optionIds": ["opt_x", "opt_y"] },
    "q3": { "text": "The checkout API in services/payments" }
  }
}
```

**Response `202` or `200` — §12** (async resume vs synchronous):

```json
{
  "messageId": "msg_…",
  "clarificationId": "clr_…",
  "processingStatus": "accepted",
  "resumeCorrelationId": "…"
}
```

If resume is async, client uses phase 50 SSE or message poll for completion.

**Errors:**

| Code | When |
|---|---|
| `404 NOT_FOUND` | Wrong tenant, soft-deleted, unknown ids |
| `409 CLARIFICATION_NOT_OPEN` | Set already answered or superseded |
| `400 VALIDATION_ERROR` | Missing required answer, invalid option, wrong type |
| `409 CLARIFICATION_ROUND_EXCEEDED` | Third set attempted |
| `403 FORBIDDEN` | No `chat.ask` or not a member |

**Optional `GET .../messages/:messageId/clarifications/:clarificationId`** for refresh — **§12**
(if message detail embed is insufficient).

### SSE (owned by phase 50 — reference only)

First exposure remains:

```json
{
  "event": "clarification",
  "data": {
    "clarificationId": "clr_…",
    "round": 1,
    "questions": [ … full list … ]
  }
}
```

## 7. Configuration & environment variables

**None.**

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `CLARIFICATION_FREE_TEXT_MAX_LENGTH` | **TBD (evaluation)** | `clarification.service.js` | Cap free-text answers |
| `CLARIFICATION_MAX_ROUNDS` | `2` | `clarification.service.js` | Initial + one follow-up (solution §5.6) |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/chat/clarification.model.js` (+ test) | **New:** schema + indexes |
| `backend/src/modules/chat/clarification.service.js` (+ `.test.js`) | **New:** validate answers, persist, resume hook |
| `backend/src/modules/chat/clarification.routes.js` (+ `.test.js`) | **New:** POST answers route |
| `backend/src/modules/chat/clarification.schemas.js` | **New:** request validation |
| `backend/src/modules/chat/index.js` | Export clarification routes |
| `backend/src/modules/chat/chat.langgraph.js` (47) | **Change:** create set on interrupt; accept resume payload |
| `backend/src/modules/chat/message.model.js` | **Change:** `awaiting_clarification` enum |
| `backend/src/modules/audit/audit.actions.js` | **Change:** `chat.clarification_answered` |
| `backend/src/http/routes.js` | Register clarification routes under conversations |

## 9. Tests (≥ 80% line and branch)

### Unit

- Valid answer map for all three types; invalid optionId → validation error.
- Open set only: second POST same clarificationId idempotent or `409` per §12 choice.
- Round 2 creation after first answers; third round blocked.
- Resume called with exact answer map keys matching question ids.

### Integration

- Full path: mock graph interrupt → POST answers → message leaves `awaiting_clarification`.
- Refresh load: GET message includes open clarification questions.
- Cross-tenant clarificationId → `404`.
- Abandoned: no POST → status unchanged after simulated time.

### Unhappy paths

- POST after message `completed` → `409`.
- Partial answers object (missing required q) → `400`.
- Soft-deleted conversation → `404`.

## 10. Definition of Done

- [ ] Clarification sets persist with typed questions and **`status: 'A' | 'D'`**.
- [ ] **One POST** accepts all answers; no per-question HTTP after set issued.
- [ ] LangGraph resumes once per POST with full answer map.
- [ ] Max **two rounds** enforced (solution §5.6).
- [ ] Abandoned state **`awaiting_clarification`** (solution §5.8).
- [ ] PROPOSED route path approved or updated in this doc before code.
- [ ] Audit action without full chat body; no in-app rate limiting.
- [ ] `npm run lint`, `npm test`; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.2 CLARIFY_SET: add POST resume pointer.
- `backend/solution.md` §5.4: unchanged; confirm API matches table (LLM full set, UI one-at-a-time, one POST).
- ADR only if embedding sets on `messages` vs separate collection is disputed.

## 12. Risks & open questions

1. **Route prefix:** is clarification nested under **`/projects/:projectId/conversations/...`**
   as proposed, or conversation-only path without project segment?
2. **After POST transport:** new SSE connection, long-poll, or synchronous completion in POST
   response?
3. **POST response code:** `200` vs `202` when resume runs async?
4. **Idempotency-Key** on answers POST — required or optional?
5. **Follow-up set:** same `messageId` (assistant run) or new assistant message row — align with 49.
6. **Free-text max length** and PII logging policy for answers in logs (must redact).
7. **Third CLARIFY_SET from model:** abstain automatically vs `500` vs user-visible retry?
8. **Separate collection vs embed** on `Message` for clarification history?
