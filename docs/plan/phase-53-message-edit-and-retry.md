# Phase 53 — Message edit with downstream replace & response retry

- **Layer:** BE
- **Depends on:** Phase 50 (message create/SSE, FLOW B runner, idempotency on send)
- **Unblocks:** Phase 54/55 retry and edit UX (frontend §53–§54, §63)
- **Size:** 1–2 days
- **Requirements covered:** backend §46–§47; solution §10.1; architecture §6.2 edit note;
  frontend §53–§54, §63; phase 12 idempotency (no in-app rate limiting)

## 1. Goal

After this phase, a user can **edit a prior user message in place**, **soft-delete** every later
message in that conversation (`status: 'D'`), and **resubmit** FLOW B from the edited content —
**one thread, no branches** (README §5, solution §10.1, backend §47). Separately, when an
**assistant** message **failed** (or retry is otherwise supported), the user can **retry** without
editing — same original user question, new generation run. Both edit-resubmit and assistant retry
honor **`Idempotency-Key`** (phase 12). Permission for edit is **`chat.ask`** plus **author of
the user message** per solution §10.1 — exact enforcement is **§12** pending confirmation.

You can see it working by editing `U1` in `U1→A1→U2→A2`, observing `A1`, `U2`, `A2` disappear
from the active thread after refresh, and receiving a new assistant answer for the edited `U1`; or
by retrying a failed assistant message while the user text stays unchanged.

## 2. Why this phase is here

Requirements §46–§47 and solution §10.1 choose **replace downstream** rather than conversation
branching (explicitly out of scope in README §5). Phase 50 only creates forward messages; without
53, edits cannot be persisted safely or ambiguity arises about which downstream context is valid.
Frontend §53–§54 and §63 require backend resubmit and retry actions.

It depends on 50 for the FLOW B entrypoint and message model. It should land before frontend edit/retry
slices so PATCH/POST contracts are stable. It does not require 52 unless a failed/clarifying message
is edited — interaction with `awaiting_clarification` is **§12**.

## 3. Scope

### In scope

- **`PATCH`** user message content (author + permission checks — **§12**).
- On successful edit: **soft-delete** all messages in the conversation with **`createdAt` >
  edited message** (same conversation, `status: 'D'`); record **`editedAt`** / optional
  **`editGeneration`** on the user row for traceability (backend §46 “what changed” — not a branch
  history).
- **Resubmit:** invoke the same FLOW B pipeline as phase 50 `POST` (SSE) from edited content;
  new assistant message row(s) appended after edited user message.
- **`POST` retry** on an **assistant** (or failed run) message: preserve linked user question
  content; do not soft-delete upstream; generate a **new** assistant attempt (frontend §63).
- **`Idempotency-Key`** on edit-resubmit and retry POSTs — duplicate returns same job/message ids
  without double soft-delete or double run.
- Reject edit on **`queued`** or in-flight processing unless **§12** defines cancel-first behavior.
- Audit: **`chat.message_edited`**, **`chat.message_retry`** — target ids only, **no** full chat
  in audit payload.

### Out of scope (owner phase)

- Conversation branches or branch switcher UI — **out of product scope** (README §5).
- Editing **assistant** message text — not in requirements; user messages only.
- Frontend inline composer — **phase 54/55**.
- Queued message edit while knowledge updating — **§12** (may defer to resend new message).
- In-app rate limiting.

## 4. Design

### 4.1 Edit + replace downstream (solution §10.1)

```text
Thread before:  U1 → A1 → U2 → A2   (all status A, ordered by createdAt)

PATCH U1.content
  authorize: chat.ask + §12 author rule
  validate: role user, status A, not archived conversation
  update U1.content, U1.editedAt
  for M in messages where conversationId && createdAt > U1.createdAt && status A
    M.status = D
  start FLOW B from U1 (SSE) with Idempotency-Key

Thread after active view:  U1 (edited) → A1' (new run)
  A1, U2, A2 remain in DB as D (not listed by default queries)
```

List/detail queries for conversations use **`status: 'A'`** only (row-status rule).

### 4.2 Assistant retry (frontend §63)

```text
POST .../messages/:assistantMessageId/retry
  load assistant message (role assistant, status A)
  resolve parent user message content (pointer or walk backward — §12)
  assert assistant.processingStatus in { failed, … retryable set }
  optional: soft-delete assistant row D or mark superseded — §12 (prefer new assistant row A)
  start FLOW B with same user content (no edit)
  Idempotency-Key → same new assistant message id if replay
```

Retry does **not** soft-delete downstream unless the retried message is not the latest — **§12**
if retry mid-thread is allowed (MVP: retry only on **latest** failed assistant or any failed — ask).

### 4.3 Interaction with clarification and queue

| State | Edit allowed? | Retry allowed? |
|---|---|---|
| `queued` (51) | **§12** | N/A on assistant |
| `awaiting_clarification` (52) | **§12** — likely cancel clarify first | **§12** |
| `running` / SSE active | **409** until terminal | **409** until terminal |
| `completed` / `failed` | Edit user per §10.1 | Retry if failed retryable |

### 4.4 Permissions (solution §10.1)

| Action | Proposed rule |
|---|---|
| Edit user message | **`chat.ask`** AND `message.authorId === principal.userId` |
| Retry assistant | **`chat.ask`** AND member of project |

**§12:** confirm author-only vs any member with `chat.ask` for edit (solution says author +
`chat.ask`).

### 4.5 Idempotency (phase 12)

- Store idempotency record keyed by `(orgId, route, Idempotency-Key)` → resulting
  `{ messageId, streamStarted }`.
- Edit PATCH + resubmit may be **one atomic endpoint** or PATCH then client POST — **§12**; if
  two steps, idempotency on the resubmit POST only.

## 5. Data model changes

Additive on **`messages`** (phase 41):

| Field | Notes |
|---|---|
| `editedAt` | Date, optional |
| `editGeneration` | number, default 0, increment on each edit |
| `supersedesMessageId` | Optional — link retry assistant to prior failed assistant (**§12**) |
| `sourceUserMessageId` | On assistant — stable link for retry |

No change to row **`status: 'A' | 'D'`** semantics. Downstream removal is **`status = 'D'`**, never
hard delete.

**Indexes:** existing conversation list by `(orgId, conversationId, createdAt)` with `status: 'A'`
must support “active thread” after edit (phase 41 — confirm).

## 6. API contract — PROPOSED (needs approval before implementation)

### `PATCH /api/v1/projects/:projectId/conversations/:conversationId/messages/:messageId`

**Permission:** `chat.ask` + author check (**§12**).

**Request:**

```json
{
  "content": "How does checkout handle payment failures after the v2 refactor?"
}
```

**Response `200`:**

```json
{
  "messageId": "msg_u1",
  "content": "…",
  "editedAt": "2026-09-12T16:00:00.000Z",
  "editGeneration": 1,
  "removedMessageIds": ["msg_a1", "msg_u2", "msg_a2"],
  "resubmit": {
    "accepted": true,
    "streamUrl": "/api/v1/conversations/…/messages",
    "idempotencyHint": "Client POST with Accept: text/event-stream to run FLOW B"
  }
}
```

**§12:** single combined **`PATCH` + SSE** vs PATCH then separate POST — document final UX before
code.

**Errors:** `404` cross-tenant; `403` not author; `409 MESSAGE_NOT_EDITABLE` (wrong role, archived,
in-flight); `400 VALIDATION_ERROR` empty content.

**Headers:** optional **`Idempotency-Key`** on PATCH if resubmit is atomic in one handler.

---

### `POST /api/v1/projects/:projectId/conversations/:conversationId/messages/:messageId/retry`

**Permission:** `chat.ask`.

**Target:** assistant `messageId` with retryable failure (or explicit retryable flag on message).

**Request:** empty body or `{ "reason": "user_retry" }`.

**Response:** same shape as phase 50 stream start — **`Accept: text/event-stream`** opens SSE for
new run; or `202` + message id if async — align with 50 (**§12**).

**Headers:** **`Idempotency-Key`** required per phase 12 for retry.

**Errors:** `409` if not failed / not retryable; `404` not found.

---

Neither endpoint logs full **`content`** in audit records.

## 7. Configuration & environment variables

**None.**

### Constants (not env)

| Constant | Where | Purpose |
|---|---|---|
| `MESSAGE_EDIT_MAX_LENGTH` | **TBD** — align with composer max from 50 | Validation |
| `MESSAGE_RETRY_ALLOWED_STATUSES` | `chat.edit.service.js` | Which `processingStatus` values allow retry |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/chat/chat.edit.service.js` (+ `.test.js`) | **New:** edit, downstream soft-delete, resubmit orchestration |
| `backend/src/modules/chat/chat.retry.service.js` (+ `.test.js`) | **New:** assistant retry |
| `backend/src/modules/chat/chat.routes.js` (+ test) | **Change:** PATCH message, POST retry |
| `backend/src/modules/chat/chat.messages.repository.js` | **Change:** bulk soft-delete after timestamp |
| `backend/src/modules/chat/message.model.js` | **Change:** edit metadata fields |
| `backend/src/modules/audit/audit.actions.js` | **Change:** `chat.message_edited`, `chat.message_retry` |
| `backend/src/platform/idempotency.js` (12) | **Change:** register keys for new routes |

## 9. Tests (≥ 80% line and branch)

### Unit

- Edit updates content, increments `editGeneration`, soft-deletes strictly later messages only.
- Edit as non-author → `403` (when §12 confirms author rule).
- Edit assistant role → `409`.
- Retry resolves correct user content; idempotency returns same outcome.
- List conversation after edit excludes `status: 'D'` rows.

### Integration

- `U1→A1→U2→A2` edit U1 → active thread length 2 after new answer completes (U1 + new A).
- Retry failed assistant → new assistant row; user message unchanged.
- Idempotency-Key duplicate retry → single new assistant.
- Cross-tenant PATCH → `404`.

### Unhappy paths

- Edit while SSE running → `409`.
- Retry on completed assistant → `409`.
- Archived conversation → `403` or `409` per phase 41.

## 10. Definition of Done

- [ ] User message edit updates in place; downstream messages **`status: 'D'`**.
- [ ] **No conversation branches** — single active thread after refresh (solution §10.1).
- [ ] FLOW B resubmit runs from edited content; assistant retry runs without user edit.
- [ ] **`Idempotency-Key`** on retry (and edit-resubmit if combined) per phase 12.
- [ ] Permission rule documented and tested per §12 confirmation.
- [ ] Audit events without full chat bodies.
- [ ] No in-app rate limiting.
- [ ] `npm run lint`, `npm test`; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `backend/solution.md` §10.1: confirm API paths match chosen combined vs two-step edit flow.
- `docs/architecture.md` §6.2 edit bullet: reference PATCH/retry routes.
- README §5 out-of-scope list unchanged (no branches).
- ADR only if edit mid-clarification or mid-queue policy is non-obvious.

## 12. Risks & open questions

1. **Edit permission:** confirm **author + `chat.ask`** only (solution §10.1) — or project admins
   too?
2. **Atomic edit + SSE:** one request or PATCH then POST messages?
3. **Retry on non-latest failed assistant:** allowed or `409`?
4. **Failed assistant row:** soft-delete on retry vs keep both with `supersedesMessageId`?
5. **Edit while `queued` (51):** update content and keep queue, or force new message?
6. **Edit while `awaiting_clarification` (52):** cancel open set automatically?
7. **`removedMessageIds` in PATCH response:** expose to UI for transparency or omit?
8. **Search index (42):** soft-deleted message text still in index until reindex — **§12** with 42.
