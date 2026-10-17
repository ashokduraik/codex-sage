# Phase 54 — Frontend conversations slice

- **Layer:** FE
- **Depends on:** Phase 19 (frontend projects slice), Phase 41 (conversation & message models),
  Phase 42 (conversation search & automatic titles)
- **Unblocks:** Phase 55 (frontend streaming answer), Phase 56, Phase 57 (chat slices that need a
  real thread shell)
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §31–§35 (embedded chat model, history,
  selection, continue, knowledge-update queue copy), §39–§44 (search, new chat, archive,
  management, active area shell), §80 (project overview → chat hand-off), §88 (empty states),
  §89 (loading), §90 (errors), §92 (mobile chat navigation), §93 (project context), §94
  (accessibility), §106 (conversation privacy); `backend/requirments.md` §40–§41, §45, §48–§50
  (lifecycle, not project knowledge); `backend/solution.md` §10.2–§10.4; `docs/architecture.md`
  §6 (chat is embedded workspace, conversations in Mongo — not ingested knowledge)

## 1. Goal

After this phase the chat **shell** runs on real conversation APIs instead of `useAppData()`.
Within a project, a signed-in user can create a conversation, see their own recent and archived
threads in the left panel, search titles and message text, rename a title, archive / restore /
soft-delete, select a thread without leaving the workspace, and read persisted messages from
`GET` endpoints — including empty, loading, and error states on mobile and desktop.

Streaming answers, clarification UI, evidence panels, metrics, and message edit/retry stay out of
scope; the composer is **disabled** with a Phase 55 guard, but **conversation list and message
history must not use mock data**.

You can see it working by opening Project → Chat: `[+ New Chat]` creates a row via the API, the
sidebar lists only **your** conversations (frontend §106), search returns backend snippets, and
archiving removes a thread from Recent while it remains under Archived.

## 2. Why this phase is here

Phase 19 provides a real project shell and `isProjectAskable`; Phases 41–42 provide persistent
conversations with search and titles. Every later chat slice (55–57, and eventually 53’s edit)
needs a stable conversation id, message list queries, and lifecycle mutations before SSE work
begins. Building the stream client first would force duplicate list/state wiring and leave mock
data in the sidebar.

It cannot come earlier because there are no conversation endpoints. It should not absorb Phase 55
work — one reviewable PR for list/history/lifecycle keeps D9 intact.

## 3. Scope

### In scope

- `conversations` API module + React Query hooks: list (recent + archived), detail header,
  paginated messages, create, rename, archive, restore, soft-delete, project-scoped search.
- Rewire `ConversationList`, `ConversationsPage`, and `ChatWorkspace` **history + message list**
  to server state; remove `useAppData()` from those paths (decision D7).
- URL selection via existing `?conv=` (outlet `activeConvId` sync).
- Privacy copy and behavior: never show another user’s threads; no UI implying conversations are
  project knowledge (frontend §106).
- Empty / skeleton / error states for no conversations, search no results, detail `404`, `403`.
- i18n for all new strings; action feedback on rename, archive, restore, delete (loader,
  `aria-busy`, inline `role="alert"` from `error.message`).
- Responsive layout: two-panel desktop (frontend §32), collapsible history on mobile (§92);
  no horizontal scroll at 375 / 768 / 1280 px.
- Read-only rendering of persisted user/assistant messages (static markdown; no live SSE).
- Global `/conversations` page: privacy note + CTA to `/projects` (no cross-project list API).

### Out of scope (owner phase)

- `POST …/streamMessage` SSE send, incremental answer, stop, stream recovery — **Phase 55**.
- Clarification one-at-a-time UI and answers POST — **Phase 56**.
- Evidence preview drawer, abstain styling polish, context metrics, knowledge-version banner —
  **Phase 57** (static evidence list may still render when present on a message DTO).
- Message edit, downstream replace, assistant retry — **Phase 53** (BE) + later FE; **not** this
  phase.
- Queued-message `202` handling during knowledge updates — **Phase 51** + **Phase 55** (this
  phase may show static banner text from project `knowledgeHealth` only).
- Home dashboard “recent conversations” — remains mock until a follow-up.
- Playwright — **Phase 63**.

## 4. Design

### 4.1 Feature layout

```text
frontend/src/features/chat/
  api/conversationsApi.js       HTTP functions (Phase 13 client)
  api/conversationTypes.js      DTO unions (known codes + string fallback)
  hooks/useConversations.js     infinite list + archived toggle
  hooks/useConversation.js      detail header
  hooks/useConversationMessages.js  paginated messages (auto-page to end)
  hooks/useConversationSearch.js  debounced search query
  hooks/useConversationMutations.js  create, rename, archive, restore, delete
  conversationQueryKeys.js      shared key factory
  ChatWorkspace.jsx             rewire list + messages; composer disabled
  ConversationList.jsx          React Query + server search
  ConversationsPage.jsx         privacy + project CTA
  MessageItem.jsx               static render for persisted rows
```

React Query keys:

```text
['conversations', 'list', projectId, { archived }]
['conversations', 'detail', projectId, conversationId]
['conversations', 'messages', projectId, conversationId]
['conversations', 'search', projectId, { q, archived }]
```

Mutations invalidate list + detail + search (+ messages on delete); selecting a conversation
loads detail + messages.

### 4.2 Privacy and tenancy

- All hooks take `projectId` from the Phase 19 outlet; never send a client-only org id.
- List and search results are **owner-only** (AS-BUILT BE); the UI does not offer a team inbox.
- Copy in `en.json` states that chat history is private to the signed-in user while project
  **knowledge** is shared (frontend §106).

### 4.3 Lifecycle UX

| Action | Control | Success | Error |
|---|---|---|---|
| New chat | `[+ New Chat]` | Create → select → focus composer area | Inline alert |
| Rename | `··· → Rename` inline | `PATCH` title | Roll back title, alert |
| Archive | `··· → Archive` | Moves to Archived view | Alert |
| Restore | Archived menu | Back to Recent | Alert |
| Delete | `··· → Delete` confirm | Soft-delete; clear selection if active | Alert |

Archived conversations remain openable; composer stays disabled until Phase 55. When the project
is not askable (`isProjectAskable`), show existing archived/unavailable copy.

Permission gates (from `me.permissions`):

- Search UI requires `conversations.search`.
- Archive / restore / delete require `conversations.archive`.
- Create / rename / list / get / messages require `chat.ask` (project route already gates chat).

### 4.4 Search

- Debounced input calls `GET …/conversation/conversation/search/:projectId` when `q` non-empty.
- Results show `title`, `snippet`, `updatedAt`; selecting sets active id and loads detail.
- Empty search → dedicated empty state, not “No data found” (frontend §88).

### 4.5 Message list (pre-stream)

- `GET …/listMessages/:projectId/:conversationId` with keyset (`items`, `nextCursor`).
- Order oldest → newest; on select, auto-fetch pages until `nextCursor` is null (capped).
- Assistant rows show stored `content` via existing `MarkdownRenderer` (static).

### 4.6 Knowledge-update banner (read-only)

When `knowledgeHealth` is `updating` or project `lifecycleStatus` is `updating`, show frontend
§35 / `chat.queuedNotice` near the composer using project detail from Phase 19 — do not simulate
queue state without Phase 51/55.

### 4.7 Accessibility

- History panel: listbox pattern; `aria-current` on selected conversation.
- Mobile history drawer: return focus to toggle on close.
- Delete confirm: destructive control not default-focused.

## 5. Data model changes

**None.** Frontend-only; consumes Phase 41–42 collections via HTTP.

## 6. API contract — AS-BUILT

**Runtime truth:** [`backend/src/http/route.js`](../../backend/src/http/route.js) under
`API_BASE_PATH` (`/api/v1`). Older phase-41/42 docs may still show `/projects/.../conversations`
paths — do not reintroduce those. This phase defines **no new backend routes**.

| Method | Path | Permission | Body / query | Response |
|---|---|---|---|---|
| `POST` | `/conversation/conversation/create/:projectId` | `chat.ask` + `Idempotency-Key` | `{ title? }` | conversation DTO (201) |
| `GET` | `/conversation/conversation/list/:projectId` | `chat.ask` | `archived`, `cursor`, `limit` | `{ items, nextCursor }` list DTOs |
| `GET` | `/conversation/conversation/search/:projectId` | `conversations.search` | `q`, `archived`, `cursor`, `limit` | `{ items: [{ id, title, snippet, updatedAt, titleSource }], nextCursor }` |
| `GET` | `/conversation/conversation/get/:projectId/:conversationId` | `chat.ask` | — | header DTO |
| `GET` | `/conversation/conversation/listMessages/:projectId/:conversationId` | `chat.ask` | `cursor`, `limit` | `{ items, nextCursor }` message DTOs |
| `PATCH` | `/conversation/conversation/rename/:projectId/:conversationId` | `chat.ask` | `{ title }` | conversation DTO |
| `POST` | `/conversation/conversation/archive/:projectId/:conversationId` | `conversations.archive` | — | conversation DTO |
| `POST` | `/conversation/conversation/restore/:projectId/:conversationId` | `conversations.archive` | — | conversation DTO |
| `DELETE` | `/conversation/conversation/delete/:projectId/:conversationId` | `conversations.archive` | — | 204 |

Conversation header DTO fields include: `id`, `projectId`, `title`, `titleSource`,
`lifecycleStatus`, `ownerUserId`, `messageCount`, `lastMessageAt`, `archivedAt`, `createdAt`,
`updatedAt`. List items omit `ownerUserId` / `archivedAt` / `projectId`.

Message DTO fields include: `id`, `role`, `content`, `messageStatus`, `createdAt`, plus optional
`evidence`, `error`, queue stamps, etc. when present — no client fabrication of `messageStatus`.

Errors: standard envelope (ADR 0010); `404` cross-tenant / missing; `403` missing permission.

Search scope: **own conversations only** (BE `buildOwnConversationFilter`).

## 7. Configuration & environment variables

**None new.** API base URL from Phase 13. Page sizes and debounce ms are **named constants** next
to the API/hooks modules (not env).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/chat/api/conversationsApi.js` | **New:** CRUD + search request functions |
| `frontend/src/features/chat/api/conversationTypes.js` | **New:** DTO typedefs with `string` fallback |
| `frontend/src/features/chat/conversationQueryKeys.js` | **New:** React Query key helpers |
| `frontend/src/features/chat/hooks/useConversations.js` | **New:** list queries |
| `frontend/src/features/chat/hooks/useConversation.js` | **New:** detail header |
| `frontend/src/features/chat/hooks/useConversationMessages.js` | **New:** message pages |
| `frontend/src/features/chat/hooks/useConversationSearch.js` | **New:** debounced search |
| `frontend/src/features/chat/hooks/useConversationMutations.js` | **New:** create/rename/archive/restore/delete |
| `frontend/tests/features/chat/**` | Hook + component tests |
| `frontend/src/features/chat/ConversationList.jsx` | Drop `useAppData`; server list + search |
| `frontend/src/features/chat/ChatWorkspace.jsx` | Server messages; disabled composer |
| `frontend/src/features/chat/ConversationsPage.jsx` | Privacy + CTA to projects |
| `frontend/src/features/chat/MessageItem.jsx` | BE `messageStatus` mapping |
| `frontend/src/shared/i18n/locales/en.json` | Privacy, search, lifecycle, Phase 55 guard |
| `frontend/src/features/projects/ProjectDetailPage.jsx` | Chat uses API project (no mock for threads) |

Do **not** delete `shared/mock-data/` until no feature imports it (D7); after this phase chat
must not import mock conversation helpers.

## 9. Tests (≥ 80% line and branch)

### Unit

- Query keys include `projectId` and `archived` flag.
- Mutations invalidate correct keys on success; surface `error.message` on failure.
- Unknown `lifecycleStatus` / `messageStatus` does not crash render.
- Create sends `Idempotency-Key`.

### Component (`*.test.jsx`, mocked API)

- Empty conversation list shows §88 copy + new-chat action.
- List fetch error → `role="alert"` + retry.
- Search with no results → dedicated empty state.
- Select conversation loads messages; skeleton while pending.
- Archive / restore list transitions.
- Delete clears selection when deleting active thread.
- `403` / `404` on detail show copy, not raw codes.
- Composer disabled with Phase 55 guard.
- ConversationsPage CTA to projects.
- Mobile viewport 375px: history toggle opens/closes without horizontal overflow.
- Search hidden without `conversations.search`; archive actions hidden without
  `conversations.archive`.

### Unhappy paths (required)

- Network failure on create conversation.
- Rename failure restores previous title.
- Optimistic archive rollback on failure (if optimistic pattern used).

## 10. Definition of Done

- [ ] `ConversationList`, `ChatWorkspace` message/history paths do not import `useAppData` or
      mock conversation getters.
- [ ] All user-facing strings via i18n; privacy note present (§106).
- [ ] React Query for all server state; no `fetch` in `useEffect`.
- [ ] Rename, archive, restore, delete follow action-feedback rules.
- [ ] Search uses backend search endpoint when `q` non-empty.
- [ ] Layouts pass 375 / 768 / 1280 without horizontal scroll.
- [ ] `npm run lint` and `npm test` in `frontend/` with ≥ 80% line+branch on touched files.
- [ ] Section 6 matches AS-BUILT `http/route.js`.

## 11. Documentation & ADR updates

- No ADR expected.
- This file’s section 6 is AS-BUILT; when conversation routes change, update this file in the
  same PR as hook adjustments. Runtime catalog remains `backend/src/http/route.js`.

## 12. Locked decisions

1. **Search scope:** own conversations only (matches BE).
2. **Messages:** separate `listMessages` keyset; auto-fetch pages to end (capped); limit 50.
3. **Composer:** disabled with Phase 55 i18n guard; no mock send/stream.
4. **Home recent conversations:** deferred (leave mock).
5. **Auto-title refresh:** `refetchOnWindowFocus` on list/detail; no polling.
6. **Shared badge:** none in MVP.
7. **Global `/conversations`:** privacy + CTA to `/projects`; no invented cross-project list.
8. **Edit/retry:** wired off (`canEdit={false}`, no retry handlers).
9. **Create:** always send `Idempotency-Key: crypto.randomUUID()`.
10. **Permissions:** gate search / archive menus on `me.permissions` as above.
