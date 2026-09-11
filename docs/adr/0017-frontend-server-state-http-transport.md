# ADR 0017 — Frontend server-state and HTTP transport

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (Phase 13 plan)

## Context

Every frontend slice from Phase 14 onward needs a shared base URL, auth header attachment,
parsed error envelope, and React Query defaults. Without one transport layer, each feature
would invent its own `fetch`, refresh loop, and retry policy.

## Decision

- **React Query** (`queryClientInstance`) is the single owner of server state. Defaults:
  no retry on HTTP 4xx, up to two retries on network/5xx, 30 s stale time, mutations never
  retry, `throwOnError: false`.
- **One `fetch` wrapper** — `frontend/src/shared/api/apiRequest.js` — is the only module under
  `frontend/src/` that calls `fetch`. Features import hooks; hooks import `shared/api`.
- **Refresh lives in the transport** (`refreshClient.js` single-flight), not in React
  components. Access tokens stay in module memory (`apiSession.js`); the httpOnly refresh
  cookie + CSRF header follow ADR 0008 / D14.
- Errors surface as `ApiError` with `status`, `code`, `message`, optional `details`,
  `correlationId` (`X-Correlation-Id` then `error.reference`), and optional
  `retryAfterSeconds`.

## Consequences

- Phase 14+ auth and feature hooks share one session-clear subscription and one refresh
  coordinator.
- Adding a second HTTP client or putting refresh in `AuthContext` would duplicate 401
  handling and break the single-flight guarantee.

## Alternatives

- Axios / ky — rejected; keep the surface small and avoid another dependency for a thin
  wrapper over `fetch`.
- Refresh inside React Query mutation defaults — rejected; login/refresh must opt out via
  `skipAuthRefresh`, and concurrent queries share one flight outside RQ.

## Escape hatch

Supersede with a new ADR if the product moves to generated OpenAPI clients or a BFF that
owns cookie refresh.
