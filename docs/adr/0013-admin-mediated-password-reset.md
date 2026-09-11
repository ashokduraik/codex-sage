# ADR 0013 — Admin-mediated password reset (no public token flow)

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (Phase 08 / D15)

## Context

Users who forget a password need a recovery path. A public forgot/reset-token flow
requires email or SMS delivery. Product scope (README §5, solution §14) excludes
outbound messaging in this slice. Returning a newly set secret in an API response would
violate secret-protection requirements (backend §148).

## Decision

- There is **no** public forgot endpoint, no reset-token collection, and no email/SMS
  channel for password recovery (D15).
- An administrator with `users.manage` sets a new password via
  `POST /api/v1/users/:userId/reset-password` with `{ newPassword }` in the body.
- The secret is **never** returned in the response, logs, or audit context. The
  administrator communicates it out of band. The response includes
  `deliveryChannel: 'administrator'` so the UI does not imply email was sent.
- Signed-in self-service change remains: `POST /api/v1/auth/password/change`.
- Every password write (self or admin) updates `passwordUpdatedAt`, revokes all sessions
  for that user, and (for admin set) sets `mustChangePassword: true`.

## Consequences

- Forgotten-password recovery depends on an administrator who can reach the user out of
  band.
- Access tokens issued before the change fail on the next request via the existing
  `passwordUpdatedAt` vs JWT `iat` check (Phase 07).
- Frontend forgot/reset pages are removed in Phase 14.

## Alternatives considered

- **Public one-time reset token + email** — rejected; email/SMS out of scope.
- **Return the new password in the admin API response** — rejected; backend §148.
- **Disable the account until the user completes a self reset** — rejected; with D15 the
  admin sets the password immediately, so session revocation + must-change is enough.

## Escape hatch

Supersede with an email-delivered token flow ADR when outbound messaging is in scope.
