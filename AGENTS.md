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
6. **No unapproved schema.** Do not add a model, collection, field, or index unless the
   user reviewed and approved that exact change in the current conversation
   (`.cursor/rules/schema-change-approval.mdc`). A plan is not approval. Comments-only
   edits to an existing model are allowed.
7. **Comments are required** on every production module and every schema field, in the
   same change as the code (`.cursor/rules/comments-required.mdc`).
8. **Plans use the create-plan skill.** Before CreatePlan, rewriting
   `docs/plan/phase-*.md` for implementation, or proposing a multi-file approach, read
   and follow [`.cursor/skills/create-plan/SKILL.md`](./.cursor/skills/create-plan/SKILL.md)
   (also `.cursor/rules/create-plan.mdc`). Schema proposals must include collection
   purpose and a per-field purpose table.

## Code style & structure

- **Descriptive file names.** Backend domain code is four modules (`access`,
  `masters`, `knowledge`, `conversation`) with one file per resource — see
  `.cursor/rules/file-colocation.mdc`. Do not add a file per function. Cap is
  1000 code lines (comments/blanks do not count); overflow is `resource.helper.js`,
  then `resource.util.js` if the helper also exceeds 1000. The 1000-line cap
  applies to production files under `src/` only — not `backend/tests/` or
  `frontend/tests/`. **API URL map:** `backend/src/http/route.js` registers every
  path (`/{module}/{file}/{action}`; GET may append `/:ids…`) with access helpers and a product-named
  `*Http` handler — see `.cursor/rules/http-routes.mdc`.

- **No deep cross-module imports.** Modules expose a public surface; internals stay private.
- **JavaScript** for all application code (frontend and backend); JSX for React.
- **Tests** live under `backend/tests/` and `frontend/tests/`, mirroring `src/`;
  cross-app E2E via Playwright when that suite exists.
- **Comments explain _why_, not _what_.** File-level JSDoc, function JSDoc, and a
  `//` on every schema field. No narration comments. No uncommented new modules.

## Trust & safety (product-critical)

- **Ground every answer** with evidence/source references; if evidence is insufficient,
  abstain / clarify — never hallucinate.
- Soft-delete user-facing resources (`status = 'D'`); every table has row `status` `A`|`D`
  (see `.cursor/rules/soft-delete.mdc` and `row-status.mdc`).
- **Never discard original failures** when mapping to catalog/`ApiError` — log message +
  stack and set `cause` (see `.cursor/rules/error-diagnostics.mdc`).
- **Secrets never get committed.** Document variables in `.env.example`. Env vars are
  only for values that must differ per environment; tunables are named constants
  (see `.cursor/rules/env-config.mdc`). Validate required env once at process start,
  not per request.

## Before you finish a change

- Respect the frontend ↔ backend boundary and non-blocking handlers.
- Colocate tests; keep coverage ≥ 80% line and branch where CI enforces it.
- Update relevant docs/ADRs when behavior or schema changes.
- Commit no secrets.
