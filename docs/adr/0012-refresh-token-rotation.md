# ADR 0012 — Refresh-token rotation with strict reuse detection

- Status: Superseded by [0030](./0030-login-session-embedded-tokens.md)
- Date: 2026-09-11
- Deciders: product owner (Phase 07 review)

## Context

Access tokens are short-lived JWTs (ADR 0007). Refresh tokens travel in an httpOnly
cookie (ADR 0008 / D14). Without server-side rotation, a stolen refresh token remains
valid until absolute expiry. Concurrent browser tabs can present the same refresh value
twice; treating every second presentation as theft is the conservative defence.

## Decision

- Every successful refresh **consumes** the presented token and issues a successor in the
  same `familyId`.
- Presenting an already-rotated (or revoked) refresh token is **reuse detection**: revoke
  **every** session row in that family with `revokedReason: 'reuse_detected'`.
- There is **no grace window** for concurrent refresh. Clients (Phase 13/14) must
  serialize refresh so two tabs do not race.
- `authenticate` loads the session by JWT `sid` and rejects revoked / expired / soft-deleted
  sessions so logout takes effect before access-token TTL.

## Consequences

- Stolen refresh tokens that race a legitimate refresh invalidate the whole login family.
- Multi-tab apps need a single in-flight refresh (shared promise / BroadcastChannel).
- Residual access tokens after logout die immediately via the `sid` check (extra indexed
  read per authenticated request).

## Alternatives considered

- **Grace window for the prior token** — rejected for Phase 07; weaker reuse signal.
- **No family revocation (reject only the presented token)** — rejected; attacker keeps
  sibling tokens.
- **Skip `sid` check (TTL-only logout)** — rejected; product chose immediate logout.

## Escape hatch

Supersede with a short grace window or client-coordinated refresh ADR if multi-tab UX
proves unacceptable without weakening reuse detection elsewhere.
