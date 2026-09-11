# ADR 0014 — Cross-tenant resource misses return 404

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (Phase 09)

## Context

When a caller asks for a resource by id that belongs to another organization, the API
could answer `403 Forbidden` (honest: the id exists but you may not see it) or
`404 Not Found` (identical to a missing id). Backend §89 requires isolation at every
layer, including not leaking the shape of another tenant's data through status codes.

## Decision

- A valid principal who requests a resource in **another** organization receives
  **`404 NOT_FOUND`**, with the same body as a genuinely missing resource.
- A valid principal who lacks permission for a resource **in their own** organization
  receives **`403 FORBIDDEN`**.
- Organization path parameters are **validated** against `request.principal.orgId` and
  never used as the tenant scope. Mismatch → `404`.
- Repositories already filter by `orgId`, so cross-tenant lookups naturally become
  not-found at the handler layer.

## Consequences

- Support engineers cannot distinguish “wrong tenant” from “missing id” from the HTTP
  status alone. Escape hatch: every response carries `X-Correlation-Id` /
  `error.reference`; Phase 10 audit logs record the real denial reason server-side.
- Existence oracles across tenants are closed.

## Alternatives considered

- **Always 403 for known ids** — rejected; confirms cross-tenant existence.
- **403 with a distinct error code for cross-tenant** — rejected; still leaks existence
  to a probing client.
