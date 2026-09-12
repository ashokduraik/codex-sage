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
- Question types from Phase 52 PROPOSED schema:
  - `single_select` — radio group
  - `multi_select` — checkbox group, at least one when required
  - `free_text` — textarea with min length when backend marks required
- Navigation: Next / Back optional (§12); **only one active question visible** (§50).
- Submit: when all answered, `POST …/clarifications/:clarificationId/answers` with aggregated
  `{ answers: { [questionId]: value | value[] } }` — **one request**.
- While POST pending: disable composer, `aria-busy`, inline errors from envelope.
- On success: clear local wizard; Phase 55 hook resumes polling/SSE or refetches conversation until
  `done` — **follow Phase 52 resume contract** (may be new SSE or async job — §12).
- Persist wizard state in session storage keyed by `conversationId + clarificationId` so navigate-
  away-and-return restores in-progress answers (§52).
- Handle second clarification round: if another `clarification` event arrives (max one extra per
  architecture), replace wizard state; show notice that more detail is needed.
- `awaiting_clarification` message status on reload: rehydrate panel from GET message/clarification
  payload if Phase 52 exposes it.
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
  → stash set { clarificationId, questions[] }
  → UI index = 0
  → user answers Q0 → index++
  → …
  → user answers Qn → POST all answers once
  → on 200: clear stash; 55 resumes stream/watch
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

## 6. API contract — PROPOSED (needs approval before implementation)

Owned by **Phase 52**. Consumed only; no new routes in this phase.

### Clarification set (via SSE — Phase 50/52)

Already delivered on stream as `clarification` event; illustrative shape:

```json
{
  "clarificationId": "6650…",
  "messageId": "6650…",
  "questions": [
    {
      "id": "q1",
      "type": "single_select",
      "prompt": "Which environment?",
      "options": [{ "id": "prod", "label": "Production" }]
    }
  ]
}
```

Exact field names **must match Phase 52 section 6** after approval.

### Submit all answers (PROPOSED — Phase 52)

```http
POST /api/v1/conversations/:conversationId/messages/:messageId/clarifications/:clarificationId/answers
Content-Type: application/json

{
  "answers": {
    "q1": "prod",
    "q2": ["orders", "payments"],
    "q3": "Enterprise tier"
  }
}
```

Permission: `chat.ask` + conversation owner.

Responses: `200` + resume handle or `202` if async; errors `409` if already answered, `422`
validation.

Optional GET for abandoned state — **only if Phase 52 defines it** (open question).

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
