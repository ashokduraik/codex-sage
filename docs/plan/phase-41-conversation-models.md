# Phase 41 — Conversation & message models with lifecycle APIs

- **Layer:** BE
- **Depends on:** Phase 17 (project model), Phase 18 (project ACL)
- **Unblocks:** Phase 42, 43, 50, 54, 60
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §40 (chat conversations), §41 (persistence),
  §45 (message model), §48 (archiving), §140–§143 (concurrent chat, isolation, knowledge vs
  conversation); `backend/solution.md` §10.2 (archive / restore / delete);
  `docs/architecture.md` §3 (what lives in Mongo), §6 (chat loads context from Mongo only)

## 1. Goal

After this phase the backend owns **`Conversation` and `Message` collections**, project-scoped
CRUD with tenant isolation, and lifecycle actions (archive, restore, soft delete) that keep
history intact while hiding archived rows from default lists. Messages are stored as individual
rows with role, content, timestamps, and a processing-status field ready for Phase 50 — not as
blobs inside audit or project knowledge.

You can see it working with `POST /api/v1/projects/:projectId/conversations` (with
`Idempotency-Key`), listing your conversations, paging messages, archiving one, and confirming
that no route writes to `KnowledgeVersion` or derived project knowledge (backend §142–§143).

## 2. Why this phase is here

Chat SSE (Phase 50) and the context pipeline (Phases 43–45) need durable conversation state and
a message schema before any model call runs. Projects (Phase 17) and project ACL (Phase 18) must
exist first because every conversation is keyed by `orgId + projectId + ownerUserId`.

Phase 18 deliberately deferred **conversation privacy** (own vs project-wide visibility) to this
phase. Search, automatic titles, and LLM flows are later phases so this slice stays a reviewable
CRUD foundation without pulling forward streaming or tokenizer work.

## 3. Scope

### In scope

- `Conversation` and `Message` Mongoose models with row `status: 'A' | 'D'` and separate
  `lifecycleStatus: 'active' | 'archived'` on conversations (README §4, solution §10.2).
- Create conversation, list (keyset), get, list messages (keyset), archive, restore, soft delete.
- **Privacy:** default list/get scope is the caller's own conversations within the project;
  broader visibility is gated by `conversations.view` (PROPOSED — section 6).
- Increment / decrement `projects.counts.conversations` on create and soft delete (Phase 17
  ownership: counts are written only when the underlying row changes).
- `Idempotency-Key` on conversation create (Phase 12).
- Audit events for conversation create, archive, restore, delete — **metadata only**, never full
  chat content (solution §9.1, README §4).
- Internal loader helpers later phases call: `loadConversationForUser`, `listRecentMessages`,
  `assertConversationWritable` — no LLM, no summarization.

### Out of scope (owner phase)

- Conversation search and title PATCH / auto-title — **Phase 42**.
- Context budgeter, tokenizer, compaction — **Phase 43**.
- Summaries, pinned facts, context metrics on messages — **Phase 44**.
- LLM client, inference queue — **Phase 45**.
- POST message + SSE, queued 202 during knowledge updates — **Phases 50, 51**.
- Message edit, downstream replace, assistant retry — **Phase 53**.
- Clarification payloads on messages — **Phase 52** (fields may be reserved as nullable).
- Retention purge of old conversations — **Phase 60**.
- Writing or mutating project knowledge from chat — **never** (backend §143).

## 4. Design

### 4.1 Module layout

```text
src/modules/conversations/
  index.js                      public surface (service + types only)
  conversations.routes.js       HTTP handlers; own reply
  conversations.service.js      use cases, audit, idempotency, count updates
  conversations.repository.js   org + project + owner filters
  conversations.model.js        Conversation schema + indexes
  messages.model.js             Message schema + indexes
  conversations.lifecycle.js    archive / restore (pure guards)
  conversations.types.js        DTOs
  conversations.access.js       resolve list visibility (own vs project-wide)
```

### 4.2 Isolation and knowledge boundary

Every repository function takes `(orgId, projectId, …)` and injects `{ orgId, projectId,
status: 'A' }`. Conversation rows also store `ownerUserId` (same as `createdBy` on create).
**No API in this phase reads another user's messages** unless the caller holds
`conversations.view` and the list/search contract (Phase 42) says otherwise — see open
question 1.

Conversations **do not** create or update `KnowledgeVersion`, document sections, or CodeGraph
indexes. Clarifications and answers stored here are conversational artifacts only (backend
§142–§143).

### 4.3 Conversation lifecycle vs row status

| Field | Values | Meaning |
|---|---|---|
| `status` | `A` \| `D` | Row visibility (soft delete) |
| `lifecycleStatus` | `active` \| `archived` | UX archive; history retained |

Archive sets `lifecycleStatus: 'archived'` and `archivedAt`; restore returns to `active`.
Soft delete sets `status: 'D'`; messages remain for retention (Phase 60) but disappear from
default API responses. **Do not** overload row `status` for archive (row-status rule).

Default list filter: `status: 'A'`, `lifecycleStatus: 'active'`. Query param `?archived=1`
returns archived conversations the caller may see (solution §10.2).

### 4.4 Message model (persistence only)

Messages belong to one conversation. Ordering is `(createdAt, _id)` ascending for thread display.
Phase 50 adds streaming writes; this phase defines the schema and read APIs.

| Concept | Phase 41 behaviour |
|---|---|
| `role` | `user` \| `assistant` \| `system` (system reserved for future internal rows; no HTTP create) |
| `content` | Markdown-compatible string; max length enforced at edge |
| `messageStatus` | `completed` for manually seeded rows; enum extended in 50 (`accepted`, `queued`, `streaming`, `failed`, …) |
| `knowledgeVersionId` | optional ObjectId; null until Phase 49 persists answers |
| `evidence`, `usage`, `contextMetrics` | optional subdocuments; null until Phases 44/49 |

Creating assistant messages via HTTP is **out of scope** — only Phase 50/49 write assistant rows
during a run. Phase 41 may insert user messages only if a future phase needs it; for this slice,
**no POST message endpoint** (owned by Phase 50).

### 4.5 Access resolution

```text
resolveConversationVisibility(orgId, userId, projectId, permissionSet):
  require project visible (Phase 18)
  if permissionSet includes conversations.view
    → may list/get any active conversation in project (PROPOSED)
  else
    → may list/get only rows where ownerUserId = userId
```

Cross-tenant access always returns `404 CONVERSATION_NOT_FOUND`, not `403` (ADR 0014 pattern).

### 4.6 Audit

| Action | Audit `action` | `context` (examples) |
|---|---|---|
| Create | `conversation.created` | `{ projectId, conversationId, titleLength }` |
| Archive | `conversation.archived` | `{ projectId, conversationId }` |
| Restore | `conversation.restored` | `{ projectId, conversationId }` |
| Delete | `conversation.deleted` | `{ projectId, conversationId }` |

Never log message `content`, evidence bodies, or clarification answers.

## 5. Data model changes

### Collection `conversations`

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | required |
| `projectId` | ObjectId | required |
| `ownerUserId` | ObjectId | creator; private context owner |
| `title` | string | 1–200 chars; default from constant until Phase 42 |
| `lifecycleStatus` | `active` \| `archived` | default `active` |
| `archivedAt` | Date \| null | set on archive |
| `lastMessageAt` | Date \| null | updated when messages are added (Phase 50); nullable in 41 |
| `messageCount` | number | default `0`; incremented when messages persist |
| `createdBy` / `updatedBy` | ObjectId | |
| `createdAt` / `updatedAt` | Date (UTC) | |
| `status` | `A` \| `D` | default `A` |

Indexes:

- `{ orgId: 1, projectId: 1, ownerUserId: 1, updatedAt: -1, _id: -1 }` partial `status: 'A'`.
- `{ orgId: 1, projectId: 1, lifecycleStatus: 1, updatedAt: -1 }` partial `status: 'A'`.

Text index for search is **Phase 42**, not here.

### Collection `messages`

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | denormalized for tenant-safe queries |
| `projectId` | ObjectId | |
| `conversationId` | ObjectId | |
| `role` | enum | see §4.4 |
| `content` | string | |
| `messageStatus` | enum | default `completed` for test/fixture rows |
| `knowledgeVersionId` | ObjectId \| null | |
| `parentMessageId` | ObjectId \| null | reserved for edit/replace (Phase 53) |
| `createdBy` | ObjectId \| null | user messages only |
| `createdAt` / `updatedAt` | Date (UTC) | |
| `status` | `A` \| `D` | soft-delete for downstream replace (Phase 53) |

Indexes:

- `{ orgId: 1, conversationId: 1, createdAt: 1, _id: 1 }` partial `status: 'A'`.
- `{ orgId: 1, projectId: 1, conversationId: 1 }` partial `status: 'A'`.

## 6. API contract — PROPOSED (needs approval before implementation)

All paths under `/api/v1`. Errors use Phase 02 envelope. Permissions from solution §8.2.
Every route uses `requireProjectPermission` (Phase 18) plus conversation visibility (§4.5).

### `POST /projects/:projectId/conversations` — `chat.ask`

Headers: `Idempotency-Key` (optional but recommended).

```json
{ "title": "Checkout flow" }
```

`title` optional; when omitted the service stores a placeholder title constant until Phase 42
allows rename / auto-title.

`201`:

```json
{
  "id": "6650f1a2c3d4e5f601020399",
  "projectId": "6650f1a2c3d4e5f601020304",
  "title": "Checkout flow",
  "lifecycleStatus": "active",
  "ownerUserId": "6650f0aa0000000000000001",
  "messageCount": 0,
  "lastMessageAt": null,
  "createdAt": "2026-09-12T10:00:00.000Z",
  "updatedAt": "2026-09-12T10:00:00.000Z"
}
```

Repeated `Idempotency-Key` → same `201` body, one row.

Errors: `400 VALIDATION_ERROR`, `401`, `403`, `404 PROJECT_NOT_FOUND`.

### `GET /projects/:projectId/conversations?limit=20&cursor=&archived=false` — `chat.ask`

Returns conversations the caller may see (§4.5). Keyset on `(updatedAt, _id)`.

```json
{
  "items": [
    {
      "id": "6650f1a2c3d4e5f601020399",
      "title": "Checkout flow",
      "lifecycleStatus": "active",
      "messageCount": 0,
      "lastMessageAt": null,
      "updatedAt": "2026-09-12T10:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

`archived=true` includes `lifecycleStatus: 'archived'`. Soft-deleted rows never appear.

### `GET /projects/:projectId/conversations/:conversationId` — `chat.ask`

Full conversation header. `404` if wrong org, deleted, or not visible to caller.

### `GET /projects/:projectId/conversations/:conversationId/messages?limit=50&cursor=` — `chat.ask`

Keyset forward through the thread (oldest-first page semantics: cursor encodes last seen
`(createdAt, _id)`).

```json
{
  "items": [
    {
      "id": "6650f1a2c3d4e5f6010203aa",
      "role": "user",
      "content": "How does checkout work?",
      "messageStatus": "completed",
      "createdAt": "2026-09-12T10:01:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Evidence, usage, and context metrics fields appear when present (Phase 44+); omitted when null.

### `POST /projects/:projectId/conversations/:conversationId/archive` — `conversations.archive`

Author must be owner **or** holder of `conversations.archive` (PROPOSED — confirm in §12).
`200` returns updated conversation with `lifecycleStatus: 'archived'`.

### `POST /projects/:projectId/conversations/:conversationId/restore` — `conversations.archive`

`200` with `lifecycleStatus: 'active'`.

### `DELETE /projects/:projectId/conversations/:conversationId` — `conversations.archive`

`204`. Soft-delete conversation row; messages remain until retention (Phase 60). Decrements
`projects.counts.conversations`.

## 7. Configuration & environment variables

**None.** List limits are named constants in the repository module
(`.cursor/rules/env-config.mdc`).

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `CONVERSATIONS_LIST_DEFAULT_LIMIT` | `20` | `conversations.repository.js` | Default page size |
| `CONVERSATIONS_LIST_MAX_LIMIT` | `100` | `conversations.repository.js` | Upper bound |
| `MESSAGES_LIST_DEFAULT_LIMIT` | `50` | `conversations.repository.js` | Message page size |
| `MESSAGES_LIST_MAX_LIMIT` | `200` | `conversations.repository.js` | Upper bound |
| `CONVERSATION_TITLE_MAX_LENGTH` | `200` | `conversations.model.js` | Validation |
| `CONVERSATION_DEFAULT_TITLE` | `New conversation` | `conversations.service.js` | Placeholder until Phase 42 |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/conversations/index.js` | Public surface |
| `backend/src/modules/conversations/conversations.model.js` | Conversation schema + indexes |
| `backend/src/modules/conversations/messages.model.js` | Message schema + indexes |
| `backend/src/modules/conversations/conversations.lifecycle.js` | Archive / restore guards |
| `backend/src/modules/conversations/conversations.access.js` | Visibility rules |
| `backend/src/modules/conversations/conversations.repository.js` | Tenant-scoped queries |
| `backend/src/modules/conversations/conversations.service.js` | Use cases, audit, counts |
| `backend/src/modules/conversations/conversations.routes.js` | HTTP handlers |
| `backend/src/modules/conversations/conversations.types.js` | DTOs |
| `backend/src/modules/conversations/*.test.js` | Colocated tests |
| `backend/src/http/routes.js` | Register conversation routes |
| `backend/src/modules/projects/projects.repository.js` | **Change:** increment/decrement `counts.conversations` |
| `backend/src/modules/audit/audit.actions.js` | **Change:** register conversation audit actions |

## 9. Tests (≥ 80% line and branch)

### Unit

- Archive / restore transitions; archive twice → `409` or idempotent success (pick one in §12).
- Visibility: owner sees own conversation; non-owner without `conversations.view` gets `404` on get.
- `resolveConversationVisibility` with `conversations.view` includes other users' rows (if PROPOSED
  approved).
- Count helpers: create increments project count; delete decrements; idempotent create does not double-count.
- Malformed cursor → `400 INVALID_CURSOR`.

### Integration (`app.inject`, Phase 03 test DB)

- Create with `Idempotency-Key` returns same id on repeat.
- List excludes `status: 'D'` and excludes archived when `archived=false`.
- Cross-org conversation id → `404`.
- Audit rows exist for create / archive / restore / delete without message content in `context`.
- Message list returns stable order across pages.

### Unhappy paths

- Missing `chat.ask` → `403`; missing project access → `404`.
- Delete then get → `404`; messages not returned on list after conversation soft-delete.
- Attempt to PATCH knowledge or project lifecycle via conversation routes — N/A (routes absent).

## 10. Definition of Done

- [ ] `Conversation` and `Message` schemas declare indexes; synced via `syncSchemaIndexes`.
- [ ] Row `status` and `lifecycleStatus` are separate fields on conversations.
- [ ] Default list hides archived and soft-deleted rows.
- [ ] No HTTP route creates assistant messages or touches project knowledge collections.
- [ ] `Idempotency-Key` honoured on conversation create.
- [ ] Audit events never contain full chat content.
- [ ] `projects.counts.conversations` updates on create/delete only.
- [ ] Every repository query includes `orgId`, `projectId`, and `status: 'A'` where applicable.
- [ ] `npm run lint` and `npm test` pass with ≥ 80% line and branch on touched files.

## 11. Documentation & ADR updates

- `docs/architecture.md` §3: add `conversations` and `messages` collections with field names from
  section 5.
- Update `docs/data-model.md` when it exists.
- No new ADR unless privacy rules in §12 choose a non-obvious sharing model.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **List/get visibility.** PROPOSED: users with `conversations.view` see all project
   conversations; everyone else sees only `ownerUserId = self`. Is that correct, or should
   org_admin always see all without a separate permission?
2. **Archive/delete permission.** PROPOSED: owner may archive/delete own threads; org admins use
   `conversations.archive`. Should project_admin also delete others' conversations?
3. **Default title string.** Is the constant `New conversation` acceptable until Phase 42, or must
   the API require an explicit title on create?
4. **Placeholder title honesty (FE §98).** If the UI shows the default title before any user text,
   is that considered fabricated copy, or acceptable as a neutral label?
5. **Shared conversations.** Requirements mention "unless explicitly shared" (§141). Is shared
   conversation support out of scope for MVP (recommended: yes — README §5)?
