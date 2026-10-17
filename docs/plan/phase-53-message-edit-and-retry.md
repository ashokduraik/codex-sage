# Phase 53 — Message edit with downstream replace & response retry

- **Layer:** BE
- **Depends on:** Phase 50 (message create/SSE, FLOW B runner, idempotency on send)
- **Unblocks:** Phase 54/55 retry and edit UX (frontend §53–§54, §63)
- **Size:** 1–2 days
- **Requirements covered:** backend §46–§47; solution §10.1; architecture §6.2 edit note;
  frontend §53–§54, §63; phase 12 idempotency (no in-app rate limiting)
- **Status:** Implemented (ADR 0036 paths; `conversation` module)

## 1. Goal

After this phase, a user can **edit a prior user message in place**, **soft-delete** every later
message in that conversation (`status: 'D'`), and **resubmit** FLOW B from the edited content —
**one thread, no branches** (README §5, solution §10.1, backend §47). Separately, when an
**assistant** message **failed** (or was interrupted), the user can **retry** without editing —
same original user question, new generation run. Both edit-resubmit and assistant retry honor
**`Idempotency-Key`**. Permission for edit is **`chat.ask`** plus **author**
(`message.createdBy === principal.userId`).

You can see it working by editing `U1` in `U1→A1→U2→A2`, observing `A1`, `U2`, `A2` disappear
from the active thread after refresh, and receiving a new assistant answer for the edited `U1`; or
by retrying a failed assistant message while the user text stays unchanged.

## 2. Why this phase is here

Requirements §46–§47 and solution §10.1 choose **replace downstream** rather than conversation
branching (explicitly out of scope in README §5). Phase 50 only creates forward messages; without
53, edits cannot be persisted safely. Frontend §53–§54 and §63 require backend resubmit and retry.

## 3. Scope

### In scope

- **`POST …/editMessage/…`** — update user content, soft-delete later turns, SSE (or 202 queue /
  200 queued-only) resubmit in one request.
- Soft-delete all messages with keyset **after** the edited user row; set **`editedAt`** /
  increment **`editGeneration`**.
- **`POST …/retryMessage/…`** — latest failed/interrupted assistant only; soft-delete that
  assistant; new assistant via `parentMessageId`; SSE/202.
- **`Idempotency-Key`** required on both routes.
- Reject edit/retry while an assistant is **`generating`**.
- Audit: **`chat.message_edited`**, **`chat.message_retry`** — target ids only, no full chat.

### Out of scope

- Conversation branches / branch switcher UI (README §5).
- Editing assistant message text.
- Frontend inline composer (phase 54/55).
- In-app rate limiting.
- Purging orphan `chatCheckpoints` for soft-deleted assistants.

## 4. Design (locked)

### 4.1 Edit + replace downstream

```text
Thread before:  U1 → A1 → U2 → A2   (all status A, ordered by createdAt)

POST editMessage U1 { content }
  authorize: chat.ask + createdBy === principal.userId
  validate: role user, status A, writable conversation
  if any assistant messageStatus === generating → 409 MESSAGE_NOT_EDITABLE
  update U1.content, U1.editedAt, U1.editGeneration++
  soft-delete M where conversationId && M after U1 (createdAt/_id keyset) && status A
  supersede open clarificationSets for removed assistants
  refresh conversations.searchText
  knowledge allow → insert assistant + SSE FLOW B
  knowledge queue → mark U1 queued + 202 (no second user row)
  knowledge deny → no persist → KNOWLEDGE_UNAVAILABLE
  U1 already queued → content-only edit, 200 JSON, stay queued

Thread after active view:  U1 (edited) → A1' (new run)
```

### 4.2 Assistant retry

```text
POST retryMessage :assistantMessageId
  role assistant, status A, messageStatus in { failed, interrupted }
  must be latest active message in conversation
  soft-delete assistant; new assistant with same parentMessageId
  SSE / 202 queue / deny — same gate rules as send
```

### 4.3 Interaction matrix

| State | Edit allowed? | Retry allowed? |
|---|---|---|
| `queued` (user) | Yes — content only, 200 JSON | N/A |
| `awaiting_clarification` | Yes on parent user (supersede sets + soft-delete) | No (not failed) |
| `generating` assistant present | 409 | 409 |
| `completed` / `failed` | Edit user per §10.1 | Retry if latest failed/interrupted |

### 4.4 Permissions

| Action | Rule |
|---|---|
| Edit user message | `chat.ask` AND `message.createdBy === principal.userId` |
| Retry assistant | `chat.ask` + project member (conversation owner writable) |

### 4.5 Idempotency

Same as phase 50: required key; replay returns **200/202 JSON** (not SSE) with
`userMessageId`, `assistantMessageId`, `messageStatus`, plus `editGeneration` /
`removedMessageIds` when applicable.

## 5. Data model

Additive on **`messages`**:

| Field | Notes |
|---|---|
| `editedAt` | Date, default null |
| `editGeneration` | number, default 0, increment on each edit |

Reuse **`parentMessageId`** for assistant → user (retry). No `supersedesMessageId` /
`sourceUserMessageId`. Downstream removal is **`status = 'D'`**.

## 6. API contract (ADR 0036)

### `POST /api/v1/conversation/chatStream/editMessage/:projectId/:conversationId/:messageId`

**Permission:** `chat.ask` + author. **Headers:** `Idempotency-Key` required;
`Accept: text/event-stream` required on allow-path SSE (not on queued 200/202).

**Body:** `{ "content": "…" }` (max `CHAT_MESSAGE_CONTENT_MAX_LENGTH`).

**Responses:** SSE (same events as streamMessage; first `status` may include
`removedMessageIds` / `editGeneration`); **202** queued JSON; **200** queued-content-only
JSON; idempotent JSON replay.

**Errors:** `404` cross-tenant/missing; `403 FORBIDDEN` not author; `409 MESSAGE_NOT_EDITABLE`;
`400 VALIDATION_ERROR`; `406 NOT_ACCEPTABLE`.

### `POST /api/v1/conversation/chatStream/retryMessage/:projectId/:conversationId/:messageId`

**Permission:** `chat.ask`. **Headers:** `Idempotency-Key` required; Accept SSE on allow path.

**Errors:** `409 MESSAGE_NOT_RETRYABLE`; `404` missing.

Neither endpoint logs full **`content`** in audit records.

## 7. Configuration & environment variables

**None.** Reuse `CHAT_MESSAGE_CONTENT_MAX_LENGTH` and `QUEUED_MESSAGE_TTL_MS`.

## 8. Files

| Path | Purpose |
|---|---|
| `backend/src/modules/conversation/chatStream.js` | `editConversationMessageHttp`, `retryConversationMessageHttp`, `runChatStreamForExistingUser` |
| `backend/src/modules/conversation/conversation.helper.js` | Soft-delete after, edit update, insert assistant for existing user |
| `backend/src/modules/conversation/clarification.js` | `supersedeOpenClarificationSetsForMessages` |
| `backend/src/http/route.js` | Register edit/retry routes |
| `backend/src/models/messages.model.js` | `editedAt`, `editGeneration` |
| `backend/src/modules/access/audit.js` | `chat.message_edited`, `chat.message_retry` |
| `backend/src/platform/errorCatalog.js` | `MESSAGE_NOT_EDITABLE`, `MESSAGE_NOT_RETRYABLE` |

## 9. Tests (≥ 80% line and branch on touched surfaces)

- Helper: soft-delete after pivot; editGeneration; in-flight = assistant generating only;
  clarify supersede.
- Routes: U1→A1→U2→A2 edit U1 → active length 2; retry failed → new assistant; idempotent
  edit replay; queued content-only; in-flight 409; completed retry 409; cross-tenant 404.

## 10. Definition of Done

- [x] User message edit updates in place; downstream messages **`status: 'D'`**.
- [x] **No conversation branches** — single active thread after refresh.
- [x] FLOW B resubmit from edited content; assistant retry without user edit.
- [x] **`Idempotency-Key`** on edit and retry.
- [x] Author + `chat.ask` for edit; audited without full chat bodies.
- [x] No in-app rate limiting.
- [x] Tests for helpers and routes.

## 11. Documentation & ADR updates

- `backend/solution.md` §10.1 — ADR paths + atomic POST+SSE.
- `docs/architecture.md` §6.2 — edit/retry routes.
- `docs/data-model.md` — `editedAt` / `editGeneration`.
- `docs/plan/phase-55-frontend-streaming-answer.md` — retry URL.
- No ADR (queue/clarify edit policy locked above).
