# ADR 0027 — Conversations are private to the owner until explicit share

- Status: Accepted
- Date: 2026-09-23
- Deciders: product owner (Phases 41–42)

## Context

Phase 18 deferred conversation privacy (own threads vs project-wide visibility) to
Phase 41. Backend §141 and frontend §106 require conversation context to stay
user-specific unless explicitly shared. The permission catalog already grants
`conversations.view` and `conversations.search` to every built-in role, including
`viewer`. Treating those keys as “see every chat in the project” would leak private
history to all members.

Solution §10.3’s parenthetical (“org_admin can search all in project”) conflicts
with that privacy rule. There is no share feature in this slice.

## Decision

- List, get, message list, and search return only conversations where
  `ownerUserId` equals the caller. Soft-deleted, other-org, and other-owner ids
  return **`404 CONVERSATION_NOT_FOUND`** (ADR 0014 / 0020 pattern).
- `conversations.view` is **not** a project-wide visibility expander. Route access
  still uses `chat.ask` (CRUD reads / rename), `conversations.search` (search), and
  `conversations.archive` (archive / restore / delete).
- Archive, restore, soft-delete, and title PATCH are **owner-only**. Holding
  `conversations.archive` or `org_admin` does not authorize acting on another
  user’s thread.
- Shared conversations are out of scope until an explicit share feature exists.
  No `sharedWith` field is stored.

## Consequences

- Phase 54 UI can list “your” conversations without a team inbox.
- Support cannot distinguish “not yours” from “missing” via HTTP status; audit
  and correlation ids remain the escape hatch.
- A later share feature needs a new ADR and additive fields; it must not reuse
  `conversations.view` as “see all.”

## Alternatives considered

- **`conversations.view` sees all project chats** — rejected; every built-in role
  already has that key.
- **org_admin / project_admin see or mutate others’ threads** — rejected for MVP;
  contradicts frontend §106 and the “unless explicitly shared” requirement.
