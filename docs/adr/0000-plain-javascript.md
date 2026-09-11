# ADR 0000 — Plain JavaScript application code

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner

## Context

The repository previously used TypeScript across `frontend/` and `backend/` (Vite/`tsc`,
`tsx`, `tsup`, `typescript-eslint`). The product owner decided to convert the entire stack to
plain JavaScript, including tooling, Cursor rules, and documentation.

## Decision

- Application source is **plain JavaScript** (`.js`) and **JSX** (`.jsx`) only.
- No TypeScript sources, no `tsc` / `typecheck`, no JSDoc/`checkJs` type-checking regime.
- Backend runs with **plain Node** (`node` / `node --watch`); no `tsx` or `tsup`.
- Frontend keeps Vite for JSX bundling and keeps the `@/` path alias via `jsconfig.json`.
- Runtime validation stays where it already exists (e.g. Zod in backend config).

## Consequences

- Compile-time type checking is removed; correctness relies on tests, lint, and runtime checks.
- Tooling and CI checklists use `lint` + `test` (no typecheck step).
- Agent/docs rules mandate JavaScript, not TypeScript.
- Backend `build` is a no-op; `start` runs `src/` directly.
- Node ESM requires explicit `.js` extensions on relative imports in `backend/`.

## Alternatives considered

- **JavaScript + JSDoc / `checkJs`** — rejected; owner chose plain JS without a type layer.
- **Keep TypeScript** — rejected.
- **Rewrite `@/` imports to relatives** — rejected; aliases remain for ergonomics.

## Escape hatch

If the project later needs static typing again, introduce a new ADR that supersedes this one
and migrate deliberately (do not mix TS and JS application sources without an ADR).
