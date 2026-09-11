# ADR 0007 — argon2id passwords and JWT access tokens

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

Multi-tenant admin and product APIs need password hashing and short-lived bearer access
tokens (solution.md §8.3). Refresh transport is a separate decision (ADR 0008 / D14).

## Decision

- Passwords are hashed with **argon2id**; plaintext passwords are never logged or stored.
- **JWT access tokens** carry identity/org claims for protected API calls; TTL and signing
  secrets live in env (`JWT_ACCESS_TOKEN_SECRET` and related); algorithm/TTL values that
  are product constants stay as named constants when implemented (D13).
- Access tokens are presented as bearers from the client (in-memory on the frontend per
  D14); they are not the refresh cookie.

**Timing:** Intent for **Phase 07** (authentication). Accepted now so Phase 07 implements
rather than re-chooses the stack.

## Consequences

- Login and password-change paths depend on argon2id parameters chosen at implementation.
- Resource servers verify JWT on protected routes before RBAC.
- Password-reset product policy (admin-mediated vs public token) may get its own ADR in
  Phase 08 (D15); this ADR does not lock that flow.

## Alternatives considered

- **bcrypt** — rejected; argon2id is the stated MVP choice in solution.md.
- **Opaque access sessions only (no JWT)** — rejected for MVP API shape; JWT access +
  refresh cookie is the plan.
- **Long-lived access tokens in cookies** — rejected; access stays short-lived and
  in-memory (see ADR 0008).

## Escape hatch

Supersede if a different password KDF or access-token format is required (e.g. PASETO);
migrate sessions deliberately and invalidate outstanding tokens.
