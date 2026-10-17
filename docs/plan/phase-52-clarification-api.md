# Phase 52 — Clarification API: set delivery, answers & resume

- **Layer:** BE
- **Depends on:** Phase 47 (LangGraph clarify interrupt, checkpoint shape, max one follow-up
  set), Phase 50 (SSE `clarification` event with full question list, message persistence)
- **Unblocks:** Phase 56 (frontend clarification slice)
- **Size:** 1–2 days
- **Requirements covered:** backend §53–§55; solution §5.4, §5.6, §5.8; architecture §6.2
  CLARIFY_SET; frontend §47–§52 (one-at-a-time UI only — not implemented here)

## 1. Goal

After this phase, when FLOW B pauses at a clarify interrupt, the backend persists a
**clarification set** (all questions the model emitted in one batch), exposes it on the
assistant message for reload, and accepts **one HTTP POST** carrying **all answers** at
once. Submitting answers **resumes** the LangGraph checkpoint once with the full answer map
over **SSE** (same event set as `streamMessage`). The product allows **at most one initial
set plus one follow-up set** (solution §5.6); a third set is rejected. If the user never
submits, the assistant message remains **`awaiting_clarification`** and is resumable
(solution §5.8). The UI showing questions one-at-a-time is **frontend-only** (phase 56).

## 2. Why this phase is here

Phase 47 defines the graph interrupt and structured question JSON; phase 50 streams the
**`clarification`** SSE payload but cannot accept answers or resume. Requirements §54–§55
require persisted clarification state across navigation and refresh, and solution §5.4 fixes
the contract: LLM emits the **full set**, UI collects locally, API receives **one payload**.

## 3. Scope

### In scope

- **`clarificationSets`** collection linked to the **assistant** `Message` (paused turn).
- Question fields: `id`, `type` (`single_select` | `multi_select` | `free_text`), `prompt`,
  `options` (string[] for select types), `required` (default true).
- **`roundIndex`:** `0` or `1` (initial vs follow-up); max two sets per assistant run.
- Message **`messageStatus`:** `awaiting_clarification` while a set is open.
- `POST /conversation/clarification/answer/:projectId` with
  `{ conversationId, messageId, clarificationSetId, answers }` in the body;
  validate types; resume LangGraph over SSE.
- Idempotent answer POST via required **`Idempotency-Key`** (replay stores JSON outcome).
- Abandoned clarification: message stays `awaiting_clarification` (solution §5.8).
- Authorization: **`chat.ask`** + project membership + conversation access.

### Out of scope (owner phase)

- UNDERSTAND prompt and JSON schema — **phase 47**.
- SSE event wiring and first `clarification` emit — **phase 50** (this phase adds persist +
  `roundIndex` on the payload).
- One-at-a-time UI — **phase 56**.
- Pinned facts from clarifications — **phase 44**.
- In-app rate limiting — **out of scope** (phase 12).
- Full chat transcript in audit — log **`chat.clarification_answered`** with ids only.

## 4. Design

### 4.1 Lifecycle

```text
User POST streamMessage → SSE … → clarify interrupt
  → persist clarificationSets (roundIndex 0, setStatus open)
  → Message.messageStatus = awaiting_clarification
  → SSE clarification { clarificationSetId, roundIndex, questions[] }

User POST clarification/answer (SSE)
  → validate all required questions answered
  → persist answers; setStatus answered
  → resume LangGraph with answer map
  → completed | failed | abstained | second clarification (roundIndex 1)

Abandoned: no POST → message stays awaiting_clarification indefinitely (MVP)
```

### 4.2 Question types (backend §53)

| Type | Answer shape | Validation |
|---|---|---|
| `single_select` | `string` | Must be one of `options[]` |
| `multi_select` | `string[]` | Non-empty subset of `options[]` when required |
| `free_text` | `string` | Trimmed; max `CLARIFICATION_FREE_TEXT_MAX_LENGTH` (2000) |

Malformed answers → `400 VALIDATION_ERROR` with field-level `details`; do not partial-resume.

### 4.3 Round cap (solution §5.6)

```text
roundIndex 0 answered → graph continues
  if second clarify → persist roundIndex 1, new clarificationSetId, SSE again
  if third attempted → graph abstains (CLARIFICATION_MAX_ROUNDS); persist rejects with
    CLARIFICATION_ROUND_EXCEEDED
```

### 4.4 Resume integration

```text
POST answer (Accept: text/event-stream)
  load Message + ClarificationSet (status A, setStatus open)
  assert messageStatus === awaiting_clarification
  assert clarificationSetId matches
  mark answered; messageStatus → generating
  resumeChatGraphFromClarification(threadId, clarificationSetId, answers)
  stream status / delta / clarification / evidence / done / error
```

`threadId` = `{orgId}:{conversationId}:{assistantMessageId}` (phase 47). Disconnect does not
abort the resume run (same as phase 50).

### 4.5 Persistence for refresh (backend §55)

- Open set embedded on listMessages DTO: `clarification: { clarificationSetId, roundIndex, questions }`.
- Partial UI progress is frontend-only; backend only knows submitted sets.
- Soft delete: superseded open rows get `setStatus: 'superseded'` and row `status: 'D'`.

## 5. Data model

### `clarificationSets` (approved)

| Field | Notes |
|---|---|
| Base | `orgId`, `status: 'A' \| 'D'`, timestamps, actors |
| `projectId`, `conversationId`, `messageId` | ObjectIds — message is the **assistant** row |
| `clarificationSetId` | Public id (matches graph/SSE) |
| `roundIndex` | `0` \| `1` |
| `setStatus` | `open` \| `answered` \| `superseded` |
| `questions` | Typed question defs |
| `answers` | Map questionId → string \| string[]; null until POST |
| `issuedAt` | When the set was issued |

Indexes (partial `status: 'A'`): unique `{ orgId, clarificationSetId }`;
`{ orgId, messageId, setStatus }` for open-set lookup.

**`messages`:** no schema change — `messageStatus` already includes `awaiting_clarification`.

## 6. API contract

### `POST /api/v1/conversation/clarification/answer/:projectId`

**Permission:** `chat.ask`; project ACL (`:projectId` required by `withProjectAccess`);
conversation access checked from the body id.
**Headers:** `Accept: text/event-stream` (else `406 NOT_ACCEPTABLE`); **`Idempotency-Key` required**.

**Request:**

```json
{
  "conversationId": "…",
  "messageId": "…assistant message id…",
  "clarificationSetId": "clr_…",
  "answers": {
    "q1": "JWT",
    "q2": ["opt_x", "opt_y"],
    "q3": "The checkout API in services/payments"
  }
}
```

**Response:** SSE stream (same events as `streamMessage`). Idempotent replay returns stored JSON
outcome (not SSE replay).

**Errors:**

| Code | When |
|---|---|
| `404 NOT_FOUND` / `CONVERSATION_NOT_FOUND` | Wrong tenant, soft-deleted, unknown ids |
| `409 CLARIFICATION_NOT_OPEN` | Set already answered or superseded |
| `400 VALIDATION_ERROR` | Missing required answer, invalid option, wrong type |
| `409 CLARIFICATION_ROUND_EXCEEDED` | Third set attempted on persist |
| `406 NOT_ACCEPTABLE` | Missing `Accept: text/event-stream` |
| `403 FORBIDDEN` | No `chat.ask` or not a member |

No separate GET clarification route — use listMessages embed.

### SSE (phase 50 + this phase)

```json
{
  "event": "clarification",
  "data": {
    "clarificationSetId": "clr_…",
    "roundIndex": 0,
    "questions": [ … full list … ]
  }
}
```

## 7. Configuration & environment variables

**None.**

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `CLARIFICATION_FREE_TEXT_MAX_LENGTH` | `2000` | `clarification.js` | Cap free-text answers |
| `CLARIFICATION_MAX_ROUNDS` | `2` | `chatGraph.helper.js` | Initial + one follow-up |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/models/clarificationSet.model.js` | Schema + indexes |
| `backend/src/modules/conversation/clarification.js` | Validate, persist, SSE resume Http |
| `backend/src/modules/conversation/index.js` | Export clarification surface + model |
| `backend/src/modules/conversation/chatStream.js` | Persist on interrupt; emit `roundIndex` |
| `backend/src/modules/conversation/chatQueue.js` | Persist on headless interrupt |
| `backend/src/modules/conversation/conversation.js` | Embed open set on listMessages DTO |
| `backend/src/http/route.js` | Register answer route |
| Audit / error catalog | `chat.clarification_answered`; clarify conflict codes |

## 9. Tests (≥ 80% line and branch)

- Valid answer map for all three types; invalid option → validation error.
- Open set only: answered → `409 CLARIFICATION_NOT_OPEN`; Idempotency-Key replay.
- Round 2 after first answers; third round blocked.
- Resume called with exact answer map keys.
- Interrupt persist → listMessages embeds clarification → answer POST SSE continues.
- Cross-tenant / soft-deleted conversation → 404; missing Accept → 406.

## 10. Definition of Done

- [x] Clarification sets persist with typed questions and **`status: 'A' | 'D'`**.
- [x] **One POST** accepts all answers; no per-question HTTP after set issued.
- [x] LangGraph resumes once per POST with full answer map over SSE.
- [x] Max **two rounds** enforced.
- [x] Abandoned state **`awaiting_clarification`**.
- [x] Route path matches conversation catalog; id is `clarificationSetId`.
- [x] Audit without full answer bodies; no in-app rate limiting.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.2: POST answer + SSE resume.
- `docs/data-model.md`: `clarificationSets` section.
- `backend/solution.md` §5.4: align id/route/SSE wording.
- `docs/plan/phase-56-frontend-clarification.md`: align contract.
- No ADR (separate collection already implied by architecture).

## 12. Locked decisions (closed)

1. **Route prefix:** `/api/v1/conversation/clarification/answer/:projectId` — only
   `projectId` is in the path (project ACL). `conversationId`, `messageId`,
   `clarificationSetId`, and `answers` are in the JSON body.
2. **After POST transport:** same POST opens SSE and streams the resumed run.
3. **POST response:** SSE 200 for live stream; idempotent replay is JSON outcome.
4. **Idempotency-Key:** required.
5. **Follow-up set:** same assistant `messageId`, new `clarificationSetId`.
6. **Free-text max:** 2000; never log answer bodies.
7. **Third clarify:** graph abstains; persist throws `CLARIFICATION_ROUND_EXCEEDED`.
8. **Storage:** separate `clarificationSets` collection (not embed on `messages`).
