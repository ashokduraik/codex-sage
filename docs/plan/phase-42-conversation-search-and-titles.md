# Phase 42 — Conversation search & automatic titles

- **Layer:** BE
- **Depends on:** Phase 41 (conversation & message models)
- **Unblocks:** Phase 54 (frontend conversations slice)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §49 (conversation search), §50 (titles),
  §41 (rename); `backend/solution.md` §10.3–§10.4; `frontend/requirments.md` §39 (chat history
  search), §98 (honesty — no fake capabilities)

## 1. Goal

After this phase users can **search accessible conversations** within a project (title + message
text via MongoDB text index) and **rename** a conversation with `PATCH`. The data layer also
supports an **automatic title** hook after the first successful assistant answer, but **LLM-based
title generation waits for Phase 45** — this phase wires persistence and policy only.

You can see it working with `GET .../conversations/search?q=checkout` returning snippets and
`PATCH .../conversations/:id { "title": "Payment failure investigation" }`, without cross-tenant
leakage and without inventing a "smart" title before a model exists.

## 2. Why this phase is here

Phase 41 stores conversations and messages but does not index them for discovery or expose rename.
Frontend §39 and backend §49 require search before the conversations UI slice (Phase 54) can drop
mocks. Search must respect the same privacy boundaries as list/get (Phase 41) plus the unresolved
product choice in solution §10.3 (open question 12 in the master plan).

Titles are split: user edit is pure CRUD here; auto-title is a product requirement (§50) that
depends on inference (Phase 45). Implementing LLM titles early would violate FE §98 if the UI
implies intelligence that is not running.

## 3. Scope

### In scope

- MongoDB **text index** on conversation `title` and message `content` (active rows only).
- `GET /projects/:projectId/conversations/search` with keyset pagination and highlighted snippet
  (PROPOSED shape — section 6).
- `PATCH /projects/:projectId/conversations/:conversationId` for `title` only.
- Internal function `maybeUpdateConversationTitle({ conversationId, trigger })` called from Phase
  49/50 after first completed assistant message — **stub behaviour until Phase 45** (§4.4).
- Search authorization aligned with list visibility + `conversations.search` permission.
- Audit: `conversation.title_changed` (old/new title lengths or hashes, not full text if policy
  prefers — never full message bodies).

### Out of scope (owner phase)

- LLM prompt for auto-title — **Phase 45** (client) + **Phase 49** (call site after first answer).
- Creating conversations, archive, delete — **Phase 41**.
- Project knowledge search — **Phase 38**.
- Embeddings / vector search — **README §5** (forbidden).
- Cross-project search — **README §5**.

## 4. Design

### 4.1 Text index strategy

Index name: `conversation_search_text`. Fields:

- On `conversations`: `title` (weight 10).
- Messages contribute through either:
  - **Option A (PROPOSED):** denormalized `searchText` on `conversations` updated when messages
    persist (Phase 50 writer maintains it), searched in one collection; or
  - **Option B:** `$lookup` + `$text` on `messages` (heavier, clearer normalization).

Pick one in §12 before implementation. Both exclude `status: 'D'` rows. No embeddings.

Snippets are built server-side from the matching field (truncate with ellipsis constant). Do not
return entire message bodies in search results unless under a max snippet length.

### 4.2 Search scope (not decided — document both paths)

Solution §10.3 states:

```text
MVP: own conversations + shared-if-any; org_admin can search all in project
```

Alternative reading: project-wide search for anyone with `conversations.view`. **This phase
implements a single scope function** `buildConversationSearchFilter(caller, projectId)` whose
rules are filled in after user confirmation (master plan open question 12). Tests must cover at
least the chosen rule plus denial for cross-tenant ids.

| Candidate rule | Filter |
|---|---|
| Own only | `ownerUserId = caller` |
| Own + org_admin all | above, OR caller has org_admin role |
| `conversations.view` all in project | holder sees all `status:'A'` conversations in project |

### 4.3 Rename

`PATCH` validates trimmed title length (same max as Phase 41). Empty title → `400`. Owner may
always rename own conversation; whether admins may rename others' threads is an open question (§12).

Updating title updates the text index on the conversation document.

### 4.4 Automatic title — deferred LLM

Requirements §50 and solution §10.4: generate a useful title after the first **successful**
assistant answer.

**Until Phase 45 exists:**

- Export `scheduleConversationAutoTitle({ conversationId, userMessageContent, assistantSummary })`
  from this module as a **no-op or placeholder policy** — do **not** call Ollama here.
- **Open product question:** may Phase 42 set an interim title from **truncated first user message**
  (e.g. first 60 chars) when the conversation still has the Phase 41 default title? That is not
  LLM-generated but can look "smart" in the UI — **FE §98** requires the UI not to imply model
  capabilities that did not run. If placeholder is allowed, document it in API responses with
  `titleSource: 'default' | 'user' | 'truncated_user_text' | 'llm'` (PROPOSED field on GET).

**After Phase 45:**

- Phase 49 invokes auto-title with a budgeted short `generateText` call (separate from answer
  draft), subject to Phase 43 preflight. Failure leaves the previous title; never blocks `done`.

### 4.5 Permissions

| Route | Permission |
|---|---|
| `GET .../search` | `conversations.search` + project access |
| `PATCH .../conversations/:id` | `chat.ask` (owner) — admin override TBD |

Phase 18 guard runs first; search never bypasses tenant filters.

## 5. Data model changes

### Additive on `conversations` (Phase 41)

| Field | Type | Notes |
|---|---|---|
| `titleSource` | enum | PROPOSED: `default`, `user`, `truncated_user_text`, `llm` |
| `searchText` | string | optional; if Option A in §4.1 — rolling concat for index |

Re-declare text index on schema (weights as §4.1). If Option B, index only on `messages.content`
with compound `{ orgId, projectId, conversationId }`.

**No change** to row `status` / `lifecycleStatus` semantics.

## 6. API contract — PROPOSED (needs approval before implementation)

### `GET /projects/:projectId/conversations/search?q=&limit=20&cursor=` — `conversations.search`

Query `q` required, min length 2 (constant). Keyset on `(score, updatedAt, _id)` or
`(updatedAt, _id)` if text score pagination is unstable — confirm in implementation.

```json
{
  "items": [
    {
      "id": "6650f1a2c3d4e5f601020399",
      "title": "Checkout flow",
      "snippet": "...payment fails when card declines...",
      "updatedAt": "2026-09-12T11:00:00.000Z",
      "titleSource": "user"
    }
  ],
  "nextCursor": null
}
```

Errors: `400` (missing/short `q`), `401`, `403`, `404 PROJECT_NOT_FOUND`.

Empty result set → `200` with `"items": []`, not an error.

### `PATCH /projects/:projectId/conversations/:conversationId` — `chat.ask`

```json
{ "title": "Payment failure investigation" }
```

`200` returns the conversation header (Phase 41 shape) with updated `title` and
`titleSource: 'user'`.

Errors: `400 VALIDATION_ERROR`, `404 CONVERSATION_NOT_FOUND`, `403`.

### Internal (not HTTP)

```text
scheduleConversationAutoTitle({ orgId, projectId, conversationId, firstUserContent, assistantMessageId })
  → void | Promise<void>
```

Documented for Phase 49; behaviour per §4.4 until Phase 45.

## 7. Configuration & environment variables

**None.**

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `CONVERSATION_SEARCH_MIN_QUERY_LENGTH` | `2` | `conversations.search.js` | Reject single-char noise |
| `CONVERSATION_SEARCH_DEFAULT_LIMIT` | `20` | `conversations.search.js` | Page size |
| `CONVERSATION_SEARCH_SNIPPET_MAX_CHARS` | `160` | `conversations.search.js` | Snippet cap |
| `CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS` | `500` | `conversations.autoTitle.js` | Cap for future LLM prompt |
| `CONVERSATION_TRUNCATED_TITLE_MAX_CHARS` | `60` | `conversations.autoTitle.js` | Interim placeholder only if approved |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/conversations/conversations.search.js` | Text query + scope filter + snippets |
| `backend/src/modules/conversations/conversations.search.test.js` | Search behaviour |
| `backend/src/modules/conversations/conversations.autoTitle.js` | Stub + future LLM hook |
| `backend/src/modules/conversations/conversations.autoTitle.test.js` | Placeholder policy tests |
| `backend/src/modules/conversations/conversations.routes.js` | Add search + PATCH |
| `backend/src/modules/conversations/conversations.service.js` | Title update + audit |
| `backend/src/modules/conversations/conversations.model.js` | Index + optional fields |
| `backend/src/modules/conversations/messages.model.js` | Index if Option B |
| `backend/src/modules/conversations/index.js` | Export auto-title scheduler |
| `backend/src/modules/audit/audit.actions.js` | `conversation.title_changed` |

## 9. Tests (≥ 80% line and branch)

### Unit

- Scope filter: own-only vs org_admin vs `conversations.view` (parameterized per chosen rule).
- Snippet builder respects max length; does not leak other users' conversations when scope is own.
- PATCH rejects empty/overlong title.
- Auto-title stub: when LLM disabled, does not change title unless truncated placeholder approved.

### Integration

- Insert fixture conversations/messages; search finds by title and by message content.
- Cross-org project id → `404`.
- User B cannot search User A's conversation when scope is own-only.
- PATCH updates index: search finds new title on old keyword only if content matched.
- Audit row on rename without storing full title in logs if policy uses length-only context.

### Unhappy paths

- `q` too short → `400`.
- Search with SQL/meta characters does not error (parameterized text search).
- Archived conversations: confirm whether search includes them (PROPOSED: exclude unless
  `archived=1` query param mirrors list — ask in §12).

## 10. Definition of Done

- [ ] Text index declared and synced; search returns snippets without full message dump.
- [ ] Search scope matches the user-confirmed rule from §12 question 1.
- [ ] PATCH title works for authorized callers; `titleSource` updated to `user`.
- [ ] No Ollama / `ai` SDK usage in this phase.
- [ ] Auto-title hook exported and documented; default implementation does not call LLM.
- [ ] No embeddings added.
- [ ] Coverage ≥ 80% line and branch on new/changed files.

## 11. Documentation & ADR updates

- `docs/architecture.md` §3: note text index fields.
- Phase 54 frontend plan consumes these PROPOSED contracts.
- No ADR unless search scope choice has long-term privacy implications worth recording.

## 12. Risks & open questions

1. **Search scope (master plan #12).** Own only vs org_admin all in project vs everyone with
   `conversations.view` — which is MVP?
2. **Truncated user-text placeholder title** before Phase 45: allowed per FE §98 honesty, or must
   title stay `New conversation` until LLM auto-title runs?
3. **Index strategy:** denormalized `searchText` on conversation (Option A) vs message collection
   text search (Option B)?
4. **Archived conversations in search:** included by default or opt-in via `archived=1`?
5. **Admin rename:** may `conversations.archive` or org_admin rename another user's conversation?
6. **Highlighting:** return plain snippet only, or marked highlights for UI bolding (FE not
   required for MVP)?
