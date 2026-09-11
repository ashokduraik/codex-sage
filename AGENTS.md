# AGENTS.md — Repo-wide conventions & guardrails

This file orients **AI agents and humans** before any change. Root conventions always apply;
Cursor rules in `.cursor/rules/` add detail.

## What this product is

A multi-tenant SaaS **enterprise software intelligence** platform: connect or upload project
source and documentation → build project knowledge → grounded conversational Q&A with
inspectable evidence. See [`backend/requirments.md`](./backend/requirments.md) and
[`frontend/requirments.md`](./frontend/requirments.md). Read those before non-trivial work.
Additional docs and ADRs live under [`docs/`](./docs/).

## Non-negotiable boundaries

1. **Stack:** React in `frontend/`; Node.js in `backend/`. **No Python** in this repo.
2. **HTTP handlers must not block on heavy work.** Ingest, analysis, indexing, retrieval, and
   other long-running work runs via **Node background jobs/workers**, not inside request
   handlers. Handlers do auth, CRUD, enqueue, and streaming/proxy of ready results.
3. **Frontend talks only to the backend.** Never invent a second client-facing API surface
   without asking.
4. **Do not assume** tech choices not spelled in requirements (datastore, HTTP framework,
   LLM provider, infra). Ask the user or record an ADR in `docs/adr/` before choosing.
5. **One concern, one place.** Schema changes only via migrations under `backend/`. Product
   requirements stay in the requirements docs; decisions go in ADRs.

## Code style & structure

- **Small, single-purpose files** with descriptive names.
- **No deep cross-module imports.** Modules expose a public surface; internals stay private.
- **TypeScript** for all new JS code (frontend and backend).
- **Tests colocated:** `*.test.ts` / `*.test.tsx` next to code; cross-app E2E via Playwright
  when that suite exists.
- **Comments explain *why*, not *what*.** No narration comments.

## Trust & safety (product-critical)

- **Ground every answer** with evidence/source references; if evidence is insufficient,
  abstain / clarify — never hallucinate.
- Soft-delete user-facing resources (`status = 'D'`); every table has row `status` `A`|`D`
  (see `.cursor/rules/soft-delete.mdc` and `row-status.mdc`).
- **Secrets never get committed.** Document variables in `.env.example`.

## Before you finish a change

- Respect the frontend ↔ backend boundary and non-blocking handlers.
- Colocate tests; keep coverage ≥ 80% line and branch where CI enforces it.
- Update relevant docs/ADRs when behavior or schema changes.
- Commit no secrets.
