# Phase 56 — Frontend clarification slice

- **Layer:** FE (+ small BE: `messageId` on SSE `clarification`)
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
sets (require all required questions answered).

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

- `ClarificationPanel` positioned per §49: inside active chat, after latest assistant content,
  above `Composer`.
- Local wizard state: `currentIndex`, `answersByQuestionId`, validation per type.
- Question types from Phase 52:
  - `single_select` — radio group (options are plain strings; answer is one string)
  - `multi_select` — checkbox group, at least one when required (answer is string[])
  - `free_text` — textarea; max length `CLARIFICATION_FREE_TEXT_MAX_LENGTH` (2000)
- Navigation: **Back and Next**; **only one active question visible** (§50).
- Submit: when all answered, one request to
  `POST /api/v1/conversation/clarification/answer/:projectId`
  with `Accept: text/event-stream`, required `Idempotency-Key`, and body
  `{ conversationId, messageId, clarificationSetId, answers: { [questionId]: string | string[] } }` —
  **SSE resume on the same POST**.
- While POST pending: disable composer, `aria-busy`, inline errors from envelope / SSE `error`.
- On stream `done`: clear local wizard; consume SSE like Phase 55. On second `clarification`:
  replace wizard and show follow-up notice.
- Persist wizard state in session storage keyed by `conversationId + clarificationSetId`.
- `awaiting_clarification` on reload: rehydrate from listMessages embed
  `message.clarification: { clarificationSetId, roundIndex, questions }` (plus `message.id`).
- SSE `clarification` payload includes **`messageId`** (assistant id) so answer POST can run
  without waiting on a refetch.
- Stream ending after `clarification` (no `done`) is terminal **`awaiting_clarification`**, not
  `interrupted`.
- i18n for prompts, validation, submit labels; keyboard operable options; focus moves to first
  control when question changes.
- Mobile: full-width controls, no horizontal scroll (375px).

### Out of scope (owner phase)

- UNDERSTAND / LLM choosing questions — backend Phase 47/52.
- Evidence, abstain, metrics — **Phase 57**.
- Message edit — **Phase 53**.
- Fake clarification from keyword heuristics — **removed in Phase 55**, must stay removed.
- Cancel/dismiss clarification API — **not supported** (abandoned stays `awaiting_clarification`).
- Playwright — **Phase 63**.

## 4. Design

### 4.1 Data flow

```text
SSE clarification event (+ messageId)
  → stash set { clarificationSetId, roundIndex, questions[], messageId }
  → UI index = 0
  → user answers Q0 → index++
  → …
  → user answers Qn → POST answer (SSE) with all answers once
  → on done: clear stash
  → on second clarification: replace stash + notice
```

No POST per intermediate question.

### 4.2 Component structure

```text
frontend/src/features/chat/
  ClarificationPanel.jsx
  ClarificationQuestion.jsx
  hooks/useClarificationWizard.js
  hooks/useSendMessage.js          (+ submitClarificationAnswers)
  api/clarificationsApi.js
  api/chatStreamApi.js             (awaiting_clarification terminal)
```

Flat layout (no `components/` folder). Tests under `frontend/tests/features/chat/`.

### 4.3 Validation

| Type | Client validation |
|---|---|
| `single_select` | exactly one option before Next |
| `multi_select` | ≥1 if `required`; each value in `options[]` |
| `free_text` | trim; max length 2000 |

No `maxSelections` (not on Phase 52 schema). Server remains authoritative; display `error.message`
on validation failures.

### 4.4 Composer interaction

While wizard active: composer **disabled** (no cancel control). User cannot send a new project
question until the set is submitted and the resume stream leaves clarification, or they navigate
away (set stays open server-side).

### 4.5 Abandoned / awaiting

If user leaves mid-wizard, session storage restores. Abandoned sets stay `awaiting_clarification`
indefinitely (Phase 52) — no deadline UI.

## 5. Data model changes

**None.**

## 6. API contract (Phase 52 — locked; additive `messageId` on SSE)

Owned by **Phase 52**. Consumed here; only additive change is `messageId` on the SSE
`clarification` event (ask + answer resume emit sites).

### Clarification set (via SSE)

```json
{
  "messageId": "…assistant message id…",
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
FE free-text max mirrors backend `CLARIFICATION_FREE_TEXT_MAX_LENGTH` (2000).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/chat/api/clarificationsApi.js` | **New:** POST answers (SSE) |
| `frontend/src/features/chat/hooks/useClarificationWizard.js` | **New:** one-at-a-time + sessionStorage |
| `frontend/src/features/chat/ClarificationPanel.jsx` | **New:** panel chrome |
| `frontend/src/features/chat/ClarificationQuestion.jsx` | **New:** type renderers |
| `frontend/src/features/chat/hooks/useSendMessage.js` | `submitClarificationAnswers` + awaiting terminal |
| `frontend/src/features/chat/api/chatStreamApi.js` | Export shared POST SSE; awaiting_clarification terminal |
| `frontend/src/features/chat/ChatWorkspace.jsx` | Mount panel; remove stub banner |
| `frontend/src/features/chat/api/conversationTypes.js` | `MessageDto.clarification` |
| `frontend/src/shared/i18n/locales/en.json` | Clarification strings |
| `backend/src/modules/conversation/chatStream.js` | `messageId` on clarification SSE |
| `backend/src/modules/conversation/clarification.js` | `messageId` on clarification SSE |
| `docs/architecture.md` | Clarification payload includes `messageId` |
| `frontend/tests/features/chat/…` | Wizard, panel, API, workspace, stream terminal |

## 9. Tests (≥ 80% line and branch)

### Unit

- Wizard shows question 0 only; after answer, shows question 1.
- Submit handler called once with full `answers` object.
- Session storage restore after unmount/remount.
- Multi-select enforces at least one selection when required.
- Stream ending after clarification → `awaiting_clarification` (not `interrupted`).

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
- Second clarification SSE — replace in-progress wizard + follow-up notice.

## 10. Definition of Done

- [ ] Exactly one clarification question visible at a time (§50).
- [ ] Exactly one POST with all answers (architecture §6.2, solution §5.4).
- [ ] Panel placement matches §49 (no modal).
- [ ] No per-question API calls after set issued.
- [ ] Session persistence for partial wizard (§52).
- [ ] i18n + a11y + action feedback on submit.
- [ ] ≥ 80% coverage on new clarification modules.
- [ ] SSE clarification includes `messageId`; FE treats clarification end as awaiting (not interrupted).

## 11. Documentation & ADR updates

- This phase doc (locked decisions, flat paths, test locations).
- `docs/architecture.md` §6.2 — clarification payload includes `messageId`.
- No new ADR (additive field on existing SSE event).

## 12. Locked decisions

1. **Resume after POST:** Same POST opens SSE and streams the resumed run (not long-poll / refetch-only).
2. **Cancel clarification:** Not supported. Composer disabled while wizard active; abandon leaves `awaiting_clarification`.
3. **Back button:** Yes — local Back/Next; one question visible.
4. **Overlapping clarification events:** Replace wizard; clear prior sessionStorage key; show follow-up notice.
5. **Reload state:** listMessages embed only — no GET clarification API.
6. **Free-text max:** Client mirror of 2000 characters; server authoritative.
