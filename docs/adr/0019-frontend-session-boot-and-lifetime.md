# ADR 0019 — Frontend session boot and lifetime

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (Phase 14 plan)

## Context

Phase 13 delivered an in-memory access-token holder, single-flight refresh, and
`subscribeSessionCleared`. Phase 14 must define how the React app boots that session,
exposes the signed-in user, and reacts when the client gives up — without putting tokens in
`localStorage` / `sessionStorage`.

Cookie and CSRF transport remain **ADR 0008** (D14). This ADR covers only the frontend
session lifecycle around that transport.

## Decision

1. **Boot:** On `AuthProvider` mount, call `refreshAccessToken()` once. On success, keep the
   access token in memory and run `GET /auth/me`. On failure, render signed-out.
   `authChecked` flips only after that sequence settles. Tests may pre-set an access token
   and current-user query data to skip the network refresh.
2. **Identity:** The UI user object comes from `GET /auth/me` (includes `permissions` and
   `mustChangePassword`), not from inventing fields client-side.
3. **Session loss:** When `clearSession()` notifies subscribers (failed refresh after 401),
   cancel queries, `queryClient.clear()`, and navigate to
   `/login?returnTo=<path>&reason=session_expired`. Intentional logout / password-change
   clear the token without that expiry notice.
4. **Password change:** Success always requires re-authentication (`reauthenticationRequired`).
   Navigate to `/login?reason=password_changed`. While `mustChangePassword` is true, protected
   app routes redirect to `/change-password`.
5. **No durable browser storage** for access tokens or user snapshots.

## Consequences

- Protected children never mount until `authChecked` and a resolved auth state.
- Mid-session expiry cannot leave stale React Query project data on screen (frontend §105.31).
- Same-origin cookie credentials remain required (ADR 0008 / Phase 13).

## Alternatives considered

- **Restore session from localStorage** — rejected; D14 / XSS surface.
- **Trust login response alone without `/auth/me`** — rejected; login summary omits
  permissions needed by later admin UI.

## Escape hatch

Supersede if a non-SPA client or SSO changes boot, or if access tokens move into httpOnly
cookies (would also supersede ADR 0008).
