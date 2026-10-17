# Phase 56 — Frontend clarification slice

- **Layer:** FE
- **Depends on:** Phase 55 (frontend streaming answer — SSE client + composer), Phase 52
  (clarification API: set delivery, answers & resume)
- **Unblocks:** None required (Phase 57 is parallel after 55); completes FLOW B clarification UX
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §47–§52 (understanding, principle, location,
  sequential, types, state preservation), §49 (placement above composer), §59–§60 (real states
  only), §92 (mobile clarification), §94, §98, §105.10–§105.13; `backend/requirments.md` §53–§55;
  `backend/solution.md` §5.2 Node B (CLARIFY_SET); `docs/architecture.md` §6.2 (one SSE
  `clarification`, local one-at-a-time, single POST of all answers)

## 1. Goal

When the backend emits an SSE `clarification` event with a **full question set**, the chat UI
shows **one question at a time** near the bottom of the active thread (above the composer), supports
single-select, multi-select, and free-text inputs, preserves answers locally while the user
steps through the set, and submits **all answers in one** `POST` when the last question is
answered — then resumes waiting on the same conversation’s stream/run lifecycle from Phase 55.

Abandoned sets show `awaiting_clarification` state on return visits; the UI must not POST partial
sets unless product explicitly allows (default: require all questions answered).

You can see it working by triggering a question that needs two clarifications: only Q1 shows
first; after choosing Production, Q2 appears; after completing the set, one network POST fires and
the assistant run continues without a modal.

## 2. Why this phase is here

Phase 50/52 deliver the clarification payload and resume endpoint; Phase 55 delivers SSE parsing
and composer placement. Frontend §50–§51 explicitly forbid showing the whole set at once and forbid
per-question server round-trips after the set is issued (solution §5.4). A dedicated slice keeps
Phase 55 reviewable and tests the CLARIFY_SET contract in isolation.

It cannot precede 55 because there is no stream hook to attach to. It should not implement
evidence or metrics (57).

## 3. Scope

### In scope

- `ClarificationPanel` (or inline block in `ChatWorkspace`) positioned per §49: inside active
  chat, after latest assistant content, above `Composer`.
- Local wizard state: `currentIndex`, `answersByQuestionId`, validation per type.
- Question types from Phase 52:
  - `single_select` — radio group (options are plain strings; answer is one string)
  - `multi_select` — checkbox group, at least one when required (answer is string[])
  - `free_text` — textarea; max length from backend constant (2000)
- Navigation: Next / Back optional (§12); **only one active question visible** (§50).
- Submit: when all answered, one request to
  `POST /api/v1/conversation/clarification/answer/:projectId`
  with `Accept: text/event-stream`, required `Idempotency-Key`, and body
  `{ conversationId, messageId, clarificationSetId, answers: { [questionId]: string | string[] } }` —
  **SSE resume on the same POST**.
- While POST pending: disable composer, `aria-busy`, inline errors from envelope / SSE `error`.
- On stream `done` (or second `clarification`): clear local wizard; consume SSE like Phase 55.
- Persist wizard state in session storage keyed by `conversationId + clarificationSetId` so navigate-
  away-and-return restores in-progress answers (§52).
- Handle second clarification round: if another `clarification` event arrives (max one extra per
  architecture), replace wizard state; show notice that more detail is needed.
- `awaiting_clarification` on reload: rehydrate from listMessages embed
  `message.clarification: { clarificationSetId, roundIndex, questions }`.
- i18n for prompts, validation, submit labels; keyboard operable options; focus moves to first
  option when question changes.
- Mobile: full-width controls, no horizontal scroll (375px).

### Out of scope (owner phase)

- UNDERSTAND / LLM choosing questions — backend Phase 47/52.
- Evidence, abstain, metrics — **Phase 57**.
- Message edit — **Phase 53**.
- Fake clarification from keyword heuristics — **removed in Phase 55**, must stay removed.
- Playwright — **Phase 63**.

## 4. Design

### 4.1 Data flow

```text
SSE clarification event
  → stash set { clarificationSetId, roundIndex, questions[] }
  → UI index = 0
  → user answers Q0 → index++
  → …
  → user answers Qn → POST answer (SSE) with all answers once
  → on done / second clarification: clear or replace stash
```

No POST per intermediate question.

### 4.2 Component structure

```text
frontend/src/features/chat/
  components/ClarificationPanel.jsx
  components/ClarificationQuestion.jsx   type-specific controls
  hooks/useClarificationWizard.js        index + answers + persistence
  hooks/useSubmitClarificationAnswers.js mutation
  api/clarificationsApi.js               POST answers
```

### 4.3 Validation

| Type | Client validation |
|---|---|
| `single_select` | exactly one option before Next |
| `multi_select` | ≥1 if `required`; respect `maxSelections` if BE sends |
| `free_text` | trim; min/max length from payload |

Server remains authoritative; display `error.message` on 422.

### 4.4 Composer interaction

While wizard active: composer disabled or hidden per §49 (“above composer” implies clarification
has focus); user cannot send a new project question until submit completes or user cancels if
cancel is supported (§12).

### 4.5 Abandoned / awaiting

If user leaves mid-wizard, session storage restores. If backend marks `awaiting_clarification` and
deadline passed, show copy from Phase 52 + option to re-ask original question (new message) — do
not invent timeout duration.

## 5. Data model changes

**None.**

## 6. API contract (Phase 52 — locked)

Owned by **Phase 52**. Consumed only; no new routes in this phase.

### Clarification set (via SSE — Phase 50/52)

```json
{
  "clarificationSetId": "clr_r0_…",
  "roundIndex": 0,
  "questions": [
    {
      "id": "q1",
      "type": "single_select",
      "prompt": "Which environment?",
      "options": ["Production", "Staging"],
      "required": true
    }
  ]
}
```

Reload embed on listMessages assistant DTO: `clarification: { clarificationSetId, roundIndex, questions }`.

### Submit all answers

```http
POST /api/v1/conversation/clarification/answer/:projectId
Accept: text/event-stream
Idempotency-Key: <required>
Content-Type: application/json

{
  "conversationId": "…",
  "messageId": "…assistant message id…",
  "clarificationSetId": "clr_r0_…",
  "answers": {
    "q1": "Production",
    "q2": ["orders", "payments"],
    "q3": "Enterprise tier"
  }
}
```

Permission: `chat.ask` + project ACL + conversation access. Response is an SSE stream
(`status` / `delta` / `clarification` / `evidence` / `done` / `error`). Errors before
headers: `409 CLARIFICATION_NOT_OPEN`, `400 VALIDATION_ERROR`, `406 NOT_ACCEPTABLE`.

## 7. Configuration & environment variables

**None new.** Session storage key prefix as named constant in `useClarificationWizard.js`.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/chat/api/clarificationsApi.js` | **New:** POST answers |
| `frontend/src/features/chat/api/clarificationsApi.test.js` | **New:** success, 422, 409 |
| `frontend/src/features/chat/hooks/useClarificationWizard.js` | **New:** one-at-a-time state + sessionStorage |
| `frontend/src/features/chat/hooks/useClarificationWizard.test.js` | **New:** advance, back, persistence |
| `frontend/src/features/chat/hooks/useSubmitClarificationAnswers.js` | **New:** mutation |
| `frontend/src/features/chat/components/ClarificationPanel.jsx` | **New:** panel chrome |
| `frontend/src/features/chat/components/ClarificationQuestion.jsx` | **New:** type renderers |
| `frontend/src/features/chat/components/ClarificationPanel.test.jsx` | **New:** sequential UX, submit once |
| `frontend/src/features/chat/ChatWorkspace.jsx` | Mount panel; wire SSE stash from 55 |
| `frontend/src/features/chat/ChatWorkspace.test.jsx` | Clarification flow integration |
| `frontend/src/shared/i18n/locales/en.json` | Clarification strings, validation |

## 9. Tests (≥ 80% line and branch)

### Unit

- Wizard shows question 0 only; after answer, shows question 1.
- Submit handler called once with full `answers` object.
- Session storage restore after unmount/remount.
- Multi-select enforces at least one selection when required.

### Component

- Single-select: cannot proceed without choice.
- Free-text: empty required field shows validation alert.
- POST failure: `role="alert"`, wizard state preserved.
- POST success: panel unmounts; composer re-enabled.
- Unauthorized POST → forbidden message.
- Mobile 375px: options stack vertically, no overflow.

### Unhappy paths (required)

- Empty `questions` array from server — fail closed with error state, no blank panel.
- Duplicate submit (409) — show server message, do not double-resume.
- SSE arrives while previous wizard incomplete — policy in §12 (replace vs block).

## 10. Definition of Done

- [ ] Exactly one clarification question visible at a time (§50).
- [ ] Exactly one POST with all answers (architecture §6.2, solution §5.4).
- [ ] Panel placement matches §49 (no modal).
- [ ] No per-question API calls after set issued.
- [ ] Session persistence for partial wizard (§52).
- [ ] i18n + a11y + action feedback on submit.
- [ ] ≥ 80% coverage on new clarification modules.

## 11. Documentation & ADR updates

- None expected.

## 12. Risks & open questions

1. **Resume after POST:** New SSE connection, long-poll, or refetch-only until message completes?
2. **Cancel clarification:** Can user dismiss and leave thread `awaiting_clarification`?
3. **Back button:** Required for multi-step, or forward-only?
4. **Overlapping clarification events:** Replace in-progress wizard or reject as error?
5. **GET clarification state:** Needed for reload, or embed in `GET conversation` message embed?
6. **Free-text PII:** Any client-side max length before POST?
