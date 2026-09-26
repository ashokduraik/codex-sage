# ADR 0030 — Login session with embedded refresh-token hashes

- Status: Accepted
- Date: 2026-09-26
- Deciders: product owner
- Supersedes: [ADR 0012](./0012-refresh-token-rotation.md)

## Context

ADR 0012 stored each refresh-token rotation as its own `sessions` row, grouped by
`familyId`. That grouping name did not say “one sign-in,” and reuse detection required
joining many rows. The product still needs rotation, reuse detection that kills the
whole login, residual access after rotate, and immediate logout via `sid`.

## Decision

- One Mongo document per sign-in: collection `loginsessions`, model `LoginSession`.
- Refresh rotations append `{ _id, refreshTokenHash, issuedAt, rotatedAt }` on `tokens[]`.
  Old hashes stay so a replay can be recognized.
- Logout sets `loggedOutAt` on the parent. Reuse, password/email change, and disable set
  `revokedAt` + `revokedReason` (`reuse_detected` | `password_changed` | `user_disabled` |
  `email_changed`).
- Access JWT `sid` is the login document `_id`. Claim `tid` is the current token-entry
  `_id`. `authenticate` loads by `sid` only; `tid` is required on verify but does not
  reject residual access after rotate.
- Presenting an already-rotated (or already-ended) refresh token is reuse: revoke that
  login. No grace window for concurrent refresh.

## Consequences

- Stolen refresh tokens that race a legitimate refresh invalidate the whole login.
- Multi-tab apps still need a single in-flight refresh.
- Residual access tokens after logout or reuse die on the next `sid` check.
- Mongo cannot `$set` and `$push` the same array in one update; rotation is a single
  pipeline update filtered by `$elemMatch` on the unrotated hash.

## Alternatives considered

- **Keep one row per token + `familyId`** — rejected; the document *is* the login.
- **Overwrite the current hash in place** — rejected; loses reuse detection.
- **Reject residual access after rotate (`tid` must be current)** — rejected; access
  tokens stay valid until their 15-minute TTL while the login is open.

## Escape hatch

Supersede if a grace window for concurrent refresh is required, or if `tid` must bind
access tokens to a single rotation.
