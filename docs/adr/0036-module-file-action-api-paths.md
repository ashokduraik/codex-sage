# ADR 0036 — Module / file / action API paths

- Status: Accepted
- Date: 2026-10-17
- Deciders: product owner

## Context

Product HTTP routes under `/api/v1` used REST-style resource nests
(`"/users"`, `"/projects/:projectId/conversations/..."`). The catalog in
`backend/src/http/route.js` is grouped by domain module and resource file, but the
URLs did not mirror that layout. Callers and agents could not infer a path from
module + file + action.

ADR 0002 keeps the versioned mount prefix `/api/v1`. This ADR only reshapes the
relative path after that prefix.

## Decision

- Every **product** route (not health) uses:
  `/{module}/{file}/{action}` then path params in order
  (`/:projectId`, `/:userId`, …).
- **module** is the domain folder: `access` | `masters` | `knowledge` | `conversation`.
- **file** is the on-disk resource basename without `.js` (camelCase, e.g. `projectMembers`).
- **HTTP methods stay real** (`GET` / `POST` / `PATCH` / `PUT` / `DELETE`). Multiple
  same-method routes on one file differ by **action**.
- Simple masters CRUD actions are `list` | `get` | `create` | `update` | `delete`.
  Other actions use camelCase product verbs (`activate`, `resetPassword`, `streamMessage`, …).
- **Health stays flat:** `GET /health`, `GET /readiness` (plus existing root aliases).
- **Hard cutover** — old paths are not dual-registered.
- Refresh cookie `Path` is `/api/v1/access/auth` (was `/api/v1/auth` in ADR 0008).
  Public allowlist paths are `/access/auth/login`, `/access/auth/refresh`,
  `/access/auth/logout` (plus health).

Registration remains only in `backend/src/http/route.js`.

## Consequences

- Frontend clients, tests, and live docs must use the new paths.
- Cookie-scoped refresh/CSRF only attach under `/api/v1/access/auth/*`.
- Phase docs that cite old URLs stay historical; they are not rewritten.

## Alternatives considered

- **Keep REST nests** — rejected; product wants module/file/action discoverability.
- **Kebab-case segments** — rejected; match disk filenames and camelCase actions (S1).
- **All-POST RPC** — rejected; keep real verbs; distinguish multi-GET files by action only.
- **Bump to `/api/v2`** — rejected for this change; hard cutover under `/api/v1` is enough
  pre-production.

## Escape hatch

Supersede with a new ADR to change the template, reintroduce dual registration, or
move health under the same scheme.
