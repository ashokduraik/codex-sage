# ADR 0002 — Fastify 5 and `/api/v1`

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

The backend needs a Node HTTP framework for JSON CRUD, SSE chat, and plugin-based
cross-cutting concerns (JWT, cookies, multipart). The API surface must be versioned
without inventing per-environment route prefixes.

## Decision

- **Fastify 5** is the HTTP framework for the API process.
- All versioned product routes mount under the constant **`API_BASE_PATH = '/api/v1'`**
  (see `backend/src/http/app.js`). The prefix is **not** an environment variable (D13).
- Unversioned infra aliases (e.g. health) may exist beside the versioned mount when
  probes need them.

**Timing:** Retrospective — Fastify and the `/api/v1` prefix shipped in Phase 01.

## Consequences

- Plugins and route modules follow Fastify registration patterns.
- Clients and the frontend target `/api/v1` until a future version ADR introduces `/api/v2`.
- Idempotency (`Idempotency-Key` + Mongo records) is a separate platform concern (Phase 12);
  in-app rate limiting is out of scope for the API process.

## Alternatives considered

- **Express** — rejected; Fastify is already in the scaffold and matches solution.md.
- **Env-configurable API base path** — rejected under D13; prefixes are constants.
- **Unversioned `/api` only** — rejected; versioned prefix keeps a clear upgrade path.

## Escape hatch

Supersede with a new ADR to change framework or introduce a new major API path prefix;
do not silently retarget clients.
