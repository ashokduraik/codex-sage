# ADR 0015 — Global route authorization via config declaration

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (Phase 09)

## Context

Every protected route must enforce RBAC. Wiring both a `config.requiredPermissions`
declaration and a separate `requirePermissions` preHandler invites drift: a forgotten
preHandler is invisible at runtime. Deny-by-default is only real if forgetting the
guard is impossible.

## Decision

- Routes declare access with exactly one of:
  - `config.routeAccess: 'public'`
  - `config.routeAccess: 'authenticated'`
  - `config.requiredPermissions: string[]` (optional `permissionMode: 'all' | 'any'`)
- A **global** Fastify `preHandler` reads that config, runs authentication when needed,
  resolves effective permissions, and denies with `403 FORBIDDEN` (without naming the
  missing permission).
- A boot-time audit walks the route table (via an `onRoute` collector) and **fails
  startup** if any route is undeclared. Public paths also match an explicit allowlist
  (`/health`, `/readiness`, `/auth/login`, `/auth/refresh`, `/auth/logout`).
- Fixed order: authenticate (inside the global hook) → permission check → (Phase 18:
  project membership) → handler.

## Consequences

- New routes must declare access or the process will not start.
- Phase 18 composes a project-access check after this hook rather than replacing it.
- Denial errors may carry non-client `authorizationDenial` fields for Phase 10 audit.

## Alternatives considered

- **Two-place convention** (declaration + per-route preHandler) — rejected; the two can
  diverge.
- **Permissions claimed in the JWT** — rejected earlier (Phase 07); role assignment and
  deactivation must take effect on the next request.
