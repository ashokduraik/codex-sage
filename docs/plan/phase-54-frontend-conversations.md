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
scope; the composer may remain disabled or show a “connect in Phase 55” guard until Phase 55 lands,
but **conversation list and message history must not use mock data**.

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

- `conversations` API module + React Query hooks: list (recent + archived), detail with messages,
  create, patch title, archive, restore, soft-delete, project-scoped search.
- Rewire `ConversationList`, `ConversationsPage` routing glue, and `ChatWorkspace` **history +
  message list** to server state; remove `useAppData()` from those paths (decision D7).
- URL or outlet state for `activeConversationId` (preserve selection across refresh where the
  router already supports `?conversation=` — match existing `ChatWorkspace` pattern).
- Privacy copy and behavior: never show another user’s threads; no UI implying conversations are
  project knowledge (frontend §106, backend §2396 area).
- Empty / skeleton / error states for no conversations, search no results, detail `404`, `403`.
- i18n for all new strings; action feedback on rename, archive, restore, delete (loader,
  `aria-busy`, inline `role="alert"` from `error.message`).
- Responsive layout: two-panel desktop (frontend §32), collapsible history on mobile (§92);
  no horizontal scroll at 375 / 768 / 1280 px.
- Read-only rendering of persisted user/assistant messages (plain text or minimal markdown preview
  **without** live SSE — full markdown/streaming is Phase 55).

### Out of scope (owner phase)

- `POST …/messages` SSE send, incremental answer, stop, stream recovery — **Phase 55**.
- Clarification one-at-a-time UI and answers POST — **Phase 56**.
- Evidence list, preview drawer, abstain styling, context metrics, knowledge-version banner —
  **Phase 57**.
- Message edit, downstream replace, assistant retry — **Phase 53** (BE) + a later FE slice or
  folded into 55/57 per product call; **not** this phase.
- Queued-message `202` handling during knowledge updates — **Phase 51** + **Phase 55** (this
  phase may show static banner text from project `knowledgeHealth` only).
- Home dashboard “recent conversations” — still mock until this or a tiny follow-up wires Home;
  **optional stretch** only if time remains (see §12).
- Playwright — **Phase 63**.

## 4. Design

### 4.1 Feature layout

```text
frontend/src/features/chat/
  api/conversationsApi.js       HTTP functions (Phase 13 client)
  api/conversationTypes.js      DTO unions (known codes + string fallback)
  hooks/useConversations.js     list + archived toggle
  hooks/useConversation.js      detail + messages (paginated if BE offers cursor)
  hooks/useConversationSearch.js  debounced search query
  hooks/useConversationMutations.js  create, patch, archive, restore, delete
  conversationQueryKeys.js      shared key factory
  ChatWorkspace.jsx             rewire list + messages; composer stub or read-only
  ConversationList.jsx          React Query + server search
  ConversationsPage.jsx         outlet / mobile history toggle
  MessageItem.jsx               static render for persisted rows (streaming attrs unused)
```

React Query keys (illustrative):

```text
['conversations', 'list', projectId, { archived }]
['conversations', 'detail', conversationId]
['conversations', 'search', projectId, { q, cursor }]
```

Mutations invalidate list + detail keys; selecting a conversation prefetches detail.

### 4.2 Privacy and tenancy

- All hooks take `projectId` from the Phase 19 outlet; never send a client-only org id.
- List and search results are **author-owned** per Phase 41/42 PROPOSED contracts; the UI does not
  offer “team inbox” or merge another user’s threads.
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

Archived conversations remain openable; composer may be disabled when project not askable
(`isProjectAskable` from Phase 19) with existing i18n patterns.

### 4.4 Search

- Debounced input calls `GET …/conversations/search` (Phase 42 PROPOSED), not local filter-only.
- Results show `title`, `snippet`, `updatedAt`; selecting sets active id and loads detail.
- Empty search → dedicated empty state, not “No data found” (frontend §88).

### 4.5 Message list (pre-stream)

- Load messages with conversation detail or nested `GET …/messages` if Phase 41 splits them —
  **follow approved Phase 41 shape**; do not invent fields.
- Order oldest → newest; scroll container preserves position on prepend when pagination added.
- Assistant rows without streaming show stored `content` markdown as **static** render (reuse
  Phase 55 markdown component only if extracted early; otherwise plain pre-wrap with note in 55).

### 4.6 Knowledge-update banner (read-only)

When `knowledgeHealth` is `updating` or project lifecycle is `updating`, show frontend §35 copy
near the composer (“queued” explanation) using project detail from Phase 19 — **do not** simulate
queue state without Phase 51/55.

### 4.7 Accessibility

- History panel: roving tabindex or listbox pattern; `aria-current` on selected conversation.
- Mobile history drawer: focus trap while open, return focus to toggle on close.
- Delete confirm: destructive control not default-focused.

## 5. Data model changes

**None.** Frontend-only; consumes Phase 41–42 collections via HTTP.

## 6. API contract — PROPOSED (needs approval before implementation)

Endpoints are **owned by Phases 41 and 42**; shapes below are consumed as-is once those phases’
section 6 documents are approved. This phase defines **no new backend routes**.

### Phase 41 — conversations (PROPOSED)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/projects/:projectId/conversations` | `chat.ask` | Create `{ title? }` → `{ id, title, lifecycleStatus, … }` |
| `GET` | `/api/v1/projects/:projectId/conversations` | `conversations.view` or `chat.ask` | List `{ items[], nextCursor }`; query `archived`, `cursor` |
| `GET` | `/api/v1/conversations/:conversationId` | owner + project ACL | Detail + messages or message sub-resource |
| `PATCH` | `/api/v1/conversations/:conversationId` | owner | `{ title }` |
| `POST` | `/api/v1/conversations/:conversationId/archive` | owner | Archive |
| `POST` | `/api/v1/conversations/:conversationId/restore` | owner | Restore |
| `DELETE` | `/api/v1/conversations/:conversationId` | owner | Soft-delete `status: 'D'` |

Message rows (read): `{ id, role, content, messageStatus, createdAt, … }` — no client-side
fabrication of `messageStatus`.

Errors: standard envelope (ADR 0010); `404` cross-tenant; `403` missing permission.

### Phase 42 — search (PROPOSED)

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/projects/:projectId/conversations/search?q=&cursor=` | `conversations.search` or `chat.ask` | `{ items: [{ id, title, snippet, updatedAt }], nextCursor }` |

Search scope (own vs org_admin all-in-project) is **not decided here** — see §12 question 1.

## 7. Configuration & environment variables

**None new.** API base URL from Phase 13. Page sizes and debounce ms are **named constants** in
`useConversationSearch.js` (not env).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/chat/api/conversationsApi.js` | **New:** CRUD + search request functions |
| `frontend/src/features/chat/api/conversationTypes.js` | **New:** DTO types with `string` fallback for enums |
| `frontend/src/features/chat/conversationQueryKeys.js` | **New:** React Query key helpers |
| `frontend/src/features/chat/hooks/useConversations.js` | **New:** list queries |
| `frontend/src/features/chat/hooks/useConversation.js` | **New:** detail + messages |
| `frontend/src/features/chat/hooks/useConversationSearch.js` | **New:** debounced search |
| `frontend/src/features/chat/hooks/useConversationMutations.js` | **New:** create/patch/archive/restore/delete |
| `frontend/src/features/chat/hooks/*.test.js` | **New:** hook behavior + error paths |
| `frontend/src/features/chat/ConversationList.jsx` | Drop `useAppData`; server list + search |
| `frontend/src/features/chat/ConversationList.test.jsx` | Rewrite for API mocks |
| `frontend/src/features/chat/ChatWorkspace.jsx` | Server messages; remove mock `askQuestion` path |
| `frontend/src/features/chat/ChatWorkspace.test.jsx` | Empty, error, selection, mobile drawer |
| `frontend/src/features/chat/ConversationsPage.jsx` | Wire project id + permissions |
| `frontend/src/features/chat/ConversationsPage.test.jsx` | Routing smoke |
| `frontend/src/features/chat/MessageItem.jsx` | Persisted message render (non-streaming) |
| `frontend/src/features/chat/MessageItem.test.jsx` | User vs assistant rows |
| `frontend/src/features/chat/index.js` | Export hooks/api |
| `frontend/src/shared/i18n/locales/en.json` | Privacy, search, lifecycle, error keys |
| `frontend/src/features/projects/ProjectDetailPage.jsx` | Pass askable flag into chat outlet if needed |

Do **not** delete `shared/mock-data/` until no feature imports it (D7); after this phase chat
must not import mock conversation helpers.

## 9. Tests (≥ 80% line and branch)

### Unit

- Query keys include `projectId` and `archived` flag.
- Mutations invalidate correct keys on success; surface `error.message` on failure.
- Unknown `lifecycleStatus` on a conversation does not crash list render.

### Component (`*.test.jsx`, mocked API)

- Empty conversation list shows §88 copy + new-chat action.
- List fetch error → `role="alert"` + retry.
- Search with no results → dedicated empty state.
- Select conversation loads messages; skeleton while pending.
- Archive moves item out of Recent (mock API sequence).
- Restore returns item to Recent.
- Delete clears selection when deleting active thread.
- `403` on detail shows forbidden copy, not raw code.
- `404` on detail shows not-found panel.
- Mobile viewport 375px: history toggle opens/closes without horizontal overflow.
- Unauthorized list (`401`) handled by Phase 13 session gate — not re-tested deeply here.

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
- [ ] Section 6 endpoints treated as PROPOSED until Phases 41–42 approved.

## 11. Documentation & ADR updates

- No ADR expected.
- When Phase 41/42 contracts change, update this file’s section 6 references in the same PR as
  hook type adjustments — do not drift silently.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Search scope:** Phase 42 README question — own conversations only vs org_admin all in project;
   affects empty states and permission errors in UI.
2. **Messages pagination:** Does Phase 41 return all messages on detail or paginate? Infinite
   scroll vs “load older” must match BE.
3. **Composer in 54:** Ship read-only composer with explanation, or feature-flag send until 55
   merges in the same sprint?
4. **Home recent conversations:** Wire in this phase or defer to avoid scope creep?
5. **Auto-title display:** Phase 42 may update title after first answer (Phase 49); should list
   poll/refetch on window focus, or rely on mutation invalidation from 55 only?
6. **Shared conversations:** Requirements allow future sharing; confirm no “shared” badge in MVP.
