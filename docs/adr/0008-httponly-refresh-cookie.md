# ADR 0008 — httpOnly refresh cookie and CSRF double-submit

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

Plan decision **D14** locks how refresh tokens move between browser and API so XSS cannot
exfiltrate the long-lived credential while CSRF on refresh/logout remains mitigated.
Access tokens stay short-lived in memory (ADR 0007).

## Decision

- The **refresh token** is an **httpOnly** cookie with `SameSite=Strict` and `Path`
  limited to `/api/v1/auth`.
- The **access token** stays in **memory** on the frontend (not `localStorage`).
- Refresh and logout requests send a **CSRF double-submit** header.
- Packages: **`@fastify/cookie`**, **`@fastify/csrf-protection`**.

**Timing:** Intent for **Phases 07 / 13 / 14**. Rotation and reuse-detection details may
get a follow-up ADR in Phase 07 without replacing this transport decision.

## Consequences

- Cross-site cookie attachment to refresh is constrained by SameSite and path.
- Frontend auth client must send credentials on auth routes and hold access tokens only
  in memory for the tab session lifetime chosen later.
- Non-browser clients need an explicit future path if cookie refresh is unsuitable.

## Alternatives considered

- **Refresh token in localStorage / memory only** — rejected; D14 requires httpOnly cookie.
- **Access token in httpOnly cookie** — rejected; access stays bearer-in-memory for API
  JSON clients and SSE.
- **SameSite=None without careful CSRF** — rejected; Strict + double-submit is the plan.

## Escape hatch

Supersede if first-party cookie constraints or a non-browser client force a different
refresh transport; document migration and CSRF implications in the new ADR.
