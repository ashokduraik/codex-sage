# ADR 0020 — Inaccessible same-org projects return 404

- Status: Accepted
- Date: 2026-09-12
- Deciders: product owner (Phase 18)

## Context

[ADR 0014](./0014-cross-tenant-404.md) closes existence oracles **across tenants**.
Backend §114/§115 also forbid confirming that a project exists when the caller is in the
same organization but lacks project access (`projectAccessMode: 'none' | 'selected'`
without a `ProjectMember` row). Returning `403 Forbidden` would teach a probing client
which project ids are real.

## Decision

- When `resolveProjectPermissions` yields `NO_ACCESS` (missing project, other org,
  inactive user, membership missing, access mode denies visibility, or soft-deleted
  member/project), project-scoped routes respond with **`404 PROJECT_NOT_FOUND`** —
  identical to a genuinely missing id.
- Once the caller is **visible** on the project but lacks the required effective
  permission, respond with **`403 FORBIDDEN`**.
- Effective permissions are `organization role permissions ∪ project overlay`
  (grants only). Overlay cannot revoke an org-granted permission.

## Consequences

- Every project-scoped route from Phase 19 onward must use
  `requireProjectPermission` (after `routeAccess: 'authenticated'`). Declaring only
  org-level `requiredPermissions` is not sufficient for `:projectId` routes.
- Support cannot distinguish “no access” from “missing id” from the HTTP status alone;
  audit/correlation ids remain the escape hatch (same as ADR 0014).

## Alternatives considered

- **403 for inaccessible same-org projects** — rejected; confirms existence inside the
  tenant.
- **Dedicated `members.manage` permission** — deferred; members APIs use effective
  `projects.update` **or** org-level `users.manage` (`any` mode).
