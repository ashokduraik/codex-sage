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
5. **One concern, one place.** Pre–go-live: declare indexes on Mongoose schemas and sync
   deliberately (`syncSchemaIndexes`); versioned migrations under `backend/` come at
   go-live. Product requirements stay in the requirements docs; decisions go in ADRs.

## Code style & structure

- **Descriptive file names.** Helpers live in the file that owns them — see
  `.cursor/rules/file-colocation.mdc`. Do not add a file per function. Cap is
  1000 code lines (comments/blanks do not count); if a file would go over, move
  work into another existing owner. Prefer fewer modules when they are the same
  concern.
- **No deep cross-module imports.** Modules expose a public surface; internals stay private.
- **JavaScript** for all application code (frontend and backend); JSX for React.
- **Tests colocated:** `*.test.js` / `*.test.jsx` next to code; cross-app E2E via Playwright
  when that suite exists.
- **Comments explain *why*, not *what*.** No narration comments.

## Trust & safety (product-critical)

- **Ground every answer** with evidence/source references; if evidence is insufficient,
  abstain / clarify — never hallucinate.
- Soft-delete user-facing resources (`status = 'D'`); every table has row `status` `A`|`D`
  (see `.cursor/rules/soft-delete.mdc` and `row-status.mdc`).
- **Secrets never get committed.** Document variables in `.env.example`. Env vars are
  only for values that must differ per environment; tunables are named constants
  (see `.cursor/rules/env-config.mdc`).

## Before you finish a change

- Respect the frontend ↔ backend boundary and non-blocking handlers.
- Colocate tests; keep coverage ≥ 80% line and branch where CI enforces it.
- Update relevant docs/ADRs when behavior or schema changes.
- Commit no secrets.
