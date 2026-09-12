# ADR 0021 — Project ACL cache invalidated via organization.aclVersion

- Status: Accepted
- Date: 2026-09-12
- Deciders: product owner (Phase 18)

## Context

`resolveProjectPermissions` is on the hot path (chat will call it per message). A
process-local LRU with a short TTL reduces load, but the API runs as multiple processes
([architecture §2](../architecture.md)) and permission revocation is a security boundary:
waiting solely on TTL (as Phase 09 does for role→permission) is too weak for project
visibility.

Redis / a shared cache is out of scope (ADR 0004 / README §5).

## Decision

- Each organization document carries an integer **`aclVersion`** (default `0`).
- The process-local project ACL cache stores `{ kind, permissions?, aclVersion }` and
  discards an entry when the organization’s current `aclVersion` differs.
- Callers that change membership roles, `projectAccessMode`, custom role permissions,
  or `ProjectMember` rows **increment** `aclVersion` and invalidate the local cache for
  that org.
- Caching is **disabled when `NODE_ENV=test`** so authorization tests never pass on
  stale state.
- A per-request memo (keyed `orgId:userId:projectId`) always applies.

## Consequences

- Revocation takes effect on the next request that observes the bumped `aclVersion`
  (one extra organization read per resolution unless the org doc is already warm).
- Multi-process lag is bounded by reading `aclVersion`, not by TTL alone. An occasional
  stale `aclVersion` read is accepted until a shared cache exists.
- Phase 09’s role-permission TTL cache remains unchanged; this ADR does not supersede it.

## Alternatives considered

- **TTL-only local cache** — rejected for project visibility/revocation.
- **Disable ACL cache until Redis** — rejected; memo + versioned LRU is enough for MVP
  load with correct security semantics.
- **Put aclVersion on Membership** — rejected; one org-wide counter invalidates all
  project ACL entries for that tenant with a single bump.
