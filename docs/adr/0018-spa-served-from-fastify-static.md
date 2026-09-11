# ADR 0018 — SPA served from Fastify static (same process)

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (Phase 13 plan)

## Context

Production browsers must load the React SPA and call `/api/v1` without inventing a
cross-origin base URL (and the CORS + credentialed-cookie work that would follow). Cloud
container / load-balancer layout remains D11 out of scope; this decision only fixes the
app-level process topology.

## Decision

- In **production**, Fastify serves `frontend/dist` via `@fastify/static` (root =
  named constant `FRONTEND_DIST_ROOT`, not an env var). Missing `index.html` fails startup
  loudly.
- SPA fallback: safe `GET`/`HEAD` outside `/api` return `index.html`; unknown `/api/*`
  keep the JSON error envelope. Static asset routes from `@fastify/static` are treated as
  `routeAccess: public` for the boot audit (`config.file` marker).
- In **development**, Fastify does **not** register static; Vite remains the HMR process
  and proxies `/api` to the API.
- Root `npm start` / `scripts/start.sh` starts **only** the backend after a frontend build.
  There is no separate frontend Node server in production.

## Consequences

- Same-origin `/api/v1` works for both modes; default `VITE_API_BASE_URL=/api/v1`.
- Operators must `npm run build` (frontend) before `npm start`.
- Worker process topology is unchanged.

## Alternatives

- `vite preview` beside the API — rejected; two processes and a second origin tempt CORS.
- nginx/CDN in front of static — deferred to D11; not required for this slice.

## Escape hatch

Supersede when D11 introduces a dedicated static host or CDN; keep the API on Fastify and
point `VITE_API_BASE_URL` at the API origin only after a CORS + cookie plan exists.
