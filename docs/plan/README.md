# Delivery plan — codex-sage

This folder is the **execution plan for all work that is still pending** on codex-sage. It is
written to be read by **both humans and AI agents**: every phase is a self-contained document
that states its goal, its inputs, the exact files it touches, the contracts it proposes, the
tests it must ship, and the checklist that decides when it is done.

Source-of-truth documents this plan derives from (read them before any non-trivial change):

| Document | What it defines |
|---|---|
| [`backend/requirments.md`](../../backend/requirments.md) | Backend product requirements (§1–§157) |
| [`frontend/requirments.md`](../../frontend/requirments.md) | UI/UX requirements (§1–§108) |
| [`backend/solution.md`](../../backend/solution.md) | Chosen MVP technical solution (§1–§15) |
| [`docs/architecture.md`](../architecture.md) | Process topology and the two main flows |
| [`AGENTS.md`](../../AGENTS.md) + [`.cursor/rules/`](../../.cursor/rules/) | Non-negotiable engineering conventions |

---

## 1. How to use this plan

### If you are a human

1. Read this README once (phase table in §6).
2. Pick the lowest-numbered phase whose dependencies are all done.
3. Open that phase document and work top to bottom. Section 6 of every phase document
   contains **proposed** API contracts — get them approved before writing the code they
   describe.
4. A phase is finished only when every box in its "Definition of Done" is ticked.

### If you are an AI agent

1. Read this README, then read **only** the phase document you were asked to implement.
2. Read the requirement sections that phase cites (they are listed as `§` numbers) — do not
   rely on this plan as a substitute for the requirements.
3. Obey [`.cursor/rules/no-assumptions.mdc`](../../.cursor/rules/no-assumptions.mdc): anything
   marked **PROPOSED** or listed under "Open questions" must be confirmed by the user before
   it is implemented. Never silently pick a default.
4. Obey [`.cursor/rules/env-config.mdc`](../../.cursor/rules/env-config.mdc): only per-environment
   values go in `.env`. Do not add pool sizes, page sizes, timeouts, or similar tunables as
   env vars.
5. Do not pull work forward from a later phase. If a later phase's work is blocking you, stop
   and ask.

---

## 2. Decisions this plan is built on

These were confirmed by the product owner and are **not** open for re-litigation inside a
phase. Anything not listed here and not in the source documents above is an open question.

| # | Decision |
|---|---|
| D1 | Plan layout: one markdown file per phase in `docs/plan/`, indexed by this README |
| D2 | Phase shape: phases 1–12 are backend/platform foundations. From phase 13 onward, a backend capability is followed by a later frontend slice that consumes it — not necessarily in the same pull request. D9 still applies: one phase ≈ one reviewable PR |
| D3 | Tech choices in `solution.md` are **not** treated as pre-locked. Phase 4 records them as ADRs (including stack choices Phase 01 already installs). Phase 5 measured CodeGraph scale and locked preview caps. Qwen context capacity, queue concurrency, run budgets, and reserved-output tokens are locked by `npm run measure-llm-host` (`scripts/measure-llm-host.mjs`); re-run on each host — see `docs/evaluation/README.md` |
| D4 | Benchmark corpus: public open-source repositories, with selection criteria documented (no customer code) |
| D5 | MongoDB: an **external MongoDB 8 replica set** is supplied through a connection-string env var. Multi-document transactions are available and may be used |
| D6 | Identity: **invite/seed only**. There is no public self-registration. `frontend/src/features/auth/RegisterPage.jsx` is removed in Phase 14. Password reset is **admin-mediated only** (D15). Signed-in self-service *password change* stays |
| D7 | Frontend mock data (`frontend/src/shared/mock-data/`) is replaced feature by feature. Each frontend slice moves its feature onto React Query + the real API and deletes that feature's mock usage; the mock module is deleted once nothing imports it |
| D8 | API contracts are **proposed inside each phase document** (section 6), marked `PROPOSED`, and must be approved before implementation |
| D9 | Phase size target: one reviewable pull request, roughly 1–2 days of focused work. The plan therefore has more than 20 phases |
| D10 | CI (GitHub Actions: lint + tests + coverage gate) is wired in the final phase (63), together with the Playwright E2E suite |
| D11 | Containerisation, deployment, and production infrastructure are **out of scope** for this plan. Target is a working local development environment with tests |
| D12 | Automated end-to-end tests come **last** (phase 63). Every earlier phase still ships unit + integration tests at ≥ 80% line and branch coverage |
| D13 | `.env` holds only values that must differ per environment (secrets, URIs, bind address, log level, encryption keys, env-specific flags). Bootstrap org/admin identity is named constants in code (ADR 0011). Driver tunables, page sizes, cache TTLs, retry/backoff, algorithm parameters, and route prefixes are named constants — not env vars (`.cursor/rules/env-config.mdc`) |
| D14 | Refresh token is an **httpOnly** cookie (`SameSite=Strict`, `Path` limited to `/api/v1/access/auth`). Access token stays in memory. Refresh and logout send a CSRF double-submit header. Packages: `@fastify/cookie`, `@fastify/csrf-protection` |
| D15 | Password reset is **admin-mediated only**. There is no public forgot/reset-token flow. An administrator with `users.manage` sets a new password in the request body; the secret is never returned. The user receives it out of band. Signed-in `POST /auth/password/change` stays |
| D16 | Integration tests use the **same external MongoDB 8 replica set** as development, with a **separate database name** (`codex_sage_test`). `mongodb-memory-server` is not used |

---

## 3. Where the codebase stands today

Ingest **FLOW A** (solution §4) is implemented through S0–S6. Repeat ZIP uploads create a new
`sourceVersion` on the same project. **ZIP-only full-tree intake is locked** (code + docs in
one archive). Folder pickers and docs-only/partial-tree merge are **not** in MVP. Change
summaries persist path diffs; API/workflow impact counts and documentation-vs-code conflicts
stay empty until a later ADR.

### Backend — `backend/`

| Exists | Notes |
|---|---|
| Platform | Fastify `/api/v1`, Mongo/Mongoose, GridFS, auth, RBAC, audit, idempotency |
| Jobs / worker | Claim, heartbeat, lease sweeper, `ingest` / `reingest` / `repo_sync` |
| Ingest | ZIP upload, exclusions, S0–S6, source diff, reingest API, GitHub/GitLab sync |
| Knowledge | Browse, search, file preview, change-summary (path lists only) |
| Conversations | Models and lifecycle APIs (Q&A engine still later) |
| Tooling | JavaScript, ESLint, Vitest + v8 coverage |

**Ingest close-out (this slice):** in-app notifications (poll), ingest/search usage facts,
retention job (last 3 ready source versions), frontend reingest. Phase 05 evaluation is
written with this close-out. A **local** Playwright journey suite lives in
[`tests/e2e/`](../../tests/e2e/) (`npm run test:e2e`; operator-started stack). GitHub
Actions CI remains Phase 63.

### Frontend — `frontend/`

| Exists | Notes |
|---|---|
| Auth, projects, ZIP upload, repo connect, processing, sources, health | Real API |
| Knowledge explorer, search, preview, changes | Real API (impact/conflicts empty) |
| Chat | Still later (LLM persist). Header notifications, admin usage, and retention defaults are live |
| Tooling | Vite, Tailwind 4, Vitest + Testing Library, ESLint |

### Docs

`docs/architecture.md` and `docs/adr/` exist. Phase 4 recorded stack ADRs. Phase 05 evaluation
doc is written as part of the ingest close-out.

---

## 4. Conventions every phase must follow

Taken from `AGENTS.md` and `.cursor/rules/`. Repeated here so a phase document does not have to.

### Code

- JavaScript only. No Python anywhere in the repo.
- Production files under `src/` stay under 1000 code lines (comments/blanks do
  not count); names under 60 characters; intention-revealing names. If a file
  would go over, move work into another existing owner — do not invent a new
  file. The 1000-line cap does not apply to `backend/tests/` or `frontend/tests/`.
- `async`/`await` only — no callback APIs, no `.then` chains.
- Every function carries JSDoc (purpose, params, returns, throws).
- Comments explain *why*, never narrate *what*.
- 2-space indent, single quotes, semicolons, max line length 100.
- Module-per-domain in the backend: service + repository + named `*Http` adapters,
  exposed through a public surface. Register every URL in `backend/src/http/route.js`
  (`/{module}/{file}/{action}/:ids…`, access helpers, product-verb `*Http` names —
  see `.cursor/rules/http-routes.mdc`). Tests live under `backend/tests/` mirroring
  `src/`. No deep imports into another module's internals.
- Feature-per-folder in the frontend: UI + hooks + API calls; tests live under
  `frontend/tests/` mirroring `src/`; cross-feature reuse goes through `shared/`.
- HTTP handlers own `res`/`reply`. Helpers return data or throw — they never write the response.
- **HTTP handlers never block on heavy work.** Heavy work is enqueued as a job for the worker.

### Data

- Every collection has a row-visibility field `status: 'A' | 'D'` (default `'A'`). Domain
  lifecycle uses a *differently named* field (`lifecycleStatus`, `jobStatus`, `userStatus`,
  `knowledgeHealth`, `connectionStatus`, …).
- Deletes and detaches are **soft**: `status: 'D'`. List and detail queries filter `status: 'A'`.
- Every query is scoped by `orgId` (and `projectId` where the resource is project-scoped)
  at the data boundary — never by trusting a client-supplied scope. Actor fields are
  `createdBy` / `updatedBy` (ObjectId → user; null allowed for system/bootstrap).
- All timestamps stored in UTC. Pagination on every list endpoint (keyset preferred).
- Pre–go-live: indexes are declared on Mongoose schemas and synced via
  `syncSchemaIndexes` in development and tests (`autoIndex: false` in production). A
  versioned migration runner is deferred until go-live / production cutover.

### Configuration

- `.env` holds only values that **must differ per environment** (secrets, connection strings,
  bind host/port, `NODE_ENV`, log level, encryption keys, env-specific flags). Bootstrap
  org/admin identity is named constants (ADR 0011). See `.cursor/rules/env-config.mdc`.
- Driver tunables, page sizes, timeouts, cache TTLs, retry/backoff, algorithm parameters, and
  route prefixes are **named constants** in the module that uses them. Do not add an env var
  "just in case". Create a constant only when the code reads it.
- `process.env` is read in one config module only. That module does not re-export constants.

### Security

- Secrets never committed. New env vars are documented in the matching `.env.example` **and**
  mirrored into the sibling `.env` in the same change (never print `.env` contents).
- Repository credentials are encrypted at rest and decrypted in memory only.
- Never log or return secrets, tokens, raw source bodies, or full chat content.
- Backend enforces permissions independently of the UI. Hiding a control is not security.
- Sensitive and administrative actions are audit-logged.

### Grounding and trust

- Every answer is grounded in retrieved project evidence with inspectable source references.
- Insufficient evidence → clarify or abstain. Never invent project behaviour.
- Never fabricate progress, token counts, context usage, timings, or tool activity.
- No private chain-of-thought is exposed — only observable execution stages.

### Tests

- Vitest, as `*.test.js` / `*.test.jsx` under `backend/tests/` and `frontend/tests/`
  mirroring `src/`.
- **≥ 80% line and branch coverage** for the code the phase touches, shipped in the same change.
- Descriptive names that state the behaviour (`it('returns 403 when the caller lacks chat.ask')`).
- Test the public surface, plus the unhappy paths: errors, authorization failures, empty and
  loading states, cross-tenant attempts.
- Playwright E2E journeys live in `tests/e2e/` (local live stack). CI wiring remains Phase 63.

### Frontend specifics

- No hardcoded user-facing strings — everything goes through i18n (`shared/i18n/locales/en.json`).
- React Query for all server state. No `fetch` inside `useEffect`.
- Every action button: inline loader, disabled while in flight, `aria-busy`, and an inline
  `role="alert"` error sourced from the API `error.message`.
- Mobile-first; must render without horizontal scroll at 375 px, 768 px and 1280 px.
- Accessibility from the start: keyboard navigation, focus management, labels, contrast,
  reduced-motion support.

### Documentation

- One decision = one ADR in `docs/adr/` (Status · Context · Decision · Consequences ·
  Alternatives · Escape hatch). ADRs are immutable once accepted; supersede rather than rewrite.
- Update `docs/architecture.md` and any data-model doc in the same change as the behaviour or
  schema it describes.
- Commit messages: one plain sentence, ≤ 150 characters, no body unless asked.

---

## 5. Out of scope for the entire plan

These are recorded as future requirements and must not appear in any phase, in the API, or in
the UI:

- Live query generation, validation, approval, or execution against a **customer application
  database** (backend §§71–82, §§121–126; frontend §§75–78), including environment switchers
  and database-query permissions as live features.
- Image upload / image-as-source processing.
- Document or code embeddings, vector search, rerankers.
- Redis, BullMQ, S3/LocalStack, MongoDB Atlas as a requirement.
- Email/SMS notification channels (in-app notifications only).
- Cross-project questions and cross-project search.
- Conversation branch switching (editing a message replaces the downstream thread instead).
- Historical code-graph retention — only the current graph exists.

---

## 6. Phase index

Legend for **Layer**: `BE` backend · `FE` frontend · `BE+FE` vertical slice · `EVAL`
measurement/decision · `DOC` documentation.

### Part A — Platform foundations

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 01 | [Runtime, configuration & MongoDB connection](./phase-01-runtime-foundations.md) | BE | — | be §104, §137, §152; sol §2–3; arch §2 |
| 02 | [Error model, correlation IDs & safe logging](./phase-02-error-model-and-logging.md) | BE | 01 | be §39, §104, §105, §148, §149 |
| 03 | [Data-layer conventions, base schema & test harness](./phase-03-data-layer-conventions.md) | BE | 01 | be §89, §101; sol §6; rules row-status, soft-delete |
| 04 | [Architecture decision records for the chosen stack](./phase-04-stack-adrs.md) | DOC | — | sol §1–2; rules docs-and-adr |
| 05 | [Evaluation & benchmark: model context, tokenizer parity, CodeGraph at scale](./phase-05-evaluation-benchmark.md) | EVAL | 04 | be §139; sol §4.4 (CodeGraph + preview caps; tokenizer/context → 43) |

### Part B — Identity, access control, audit

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 06 | [Tenancy & identity models with bootstrap seed](./phase-06-tenancy-identity-models.md) | BE | 03 | be §3–5; sol §8.1 |
| 07 | [Authentication: argon2 passwords, JWT access & refresh](./phase-07-authentication.md) | BE | 06 | be §5, §88, §90; fe §7A; sol §8.3 |
| 08 | [Password lifecycle: signed-in change and admin-set password](./phase-08-password-lifecycle.md) | BE | 07 | be §5; fe §7A, §84 |
| 09 | [RBAC engine & route authorization](./phase-09-rbac-engine.md) | BE | 07 | be §6, §89, §90; sol §8.2 |
| 10 | [Audit logging](./phase-10-audit-logging.md) | BE | 09 | be §86, §87, §150; sol §9 |
| 11 | [Admin identity APIs: users, roles, memberships](./phase-11-admin-identity-apis.md) | BE | 09, 10 | be §5, §6, §135, §136; sol §8.4 |
| 12 | [Idempotency (no in-app rate limiting)](./phase-12-rate-limit-idempotency.md) | BE | 03, 09 | be §92; sol §13 |

### Part C — Frontend platform, auth and admin slices

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 13 | [Frontend API client & server-state layer](./phase-13-frontend-api-client.md) | FE | 07 | fe §90, §98; rules web-frontend, ui-action-feedback |
| 14 | [Frontend auth slice; remove self-registration](./phase-14-frontend-auth-slice.md) | FE | 13 | fe §7A, §105.31 |
| 15 | [Frontend admin users & roles slice](./phase-15-frontend-admin-users-roles.md) | FE | 11, 14 | fe §82–85 |
| 16 | [Frontend admin audit slice](./phase-16-frontend-admin-audit.md) | FE | 10, 14 | fe §87A, §105.37 |

### Part D — Projects

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 17 | [Project model, CRUD & lifecycle states](./phase-17-project-model-and-crud.md) | BE | 09, 10, 12 | be §7, §9, §102, §111, §153; fe §9, §81B |
| 18 | [Project membership & project-scoped authorization](./phase-18-project-acl.md) | BE | 17 | be §8, §89, §114, §115; sol §8.1 |
| 19 | [Frontend projects slice](./phase-19-frontend-projects-slice.md) | FE | 14, 17, 18 | fe §8, §9, §30, §81, §81B, §88 |

### Part E — Jobs and the worker process

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 20 | [Job & JobEvent models with job read APIs](./phase-20-job-models-and-apis.md) | BE | 03, 17 | be §31–35, §95, §97, §154; sol §7 |
| 21 | [Worker process: claim, heartbeat, lease sweeper, scheduler](./phase-21-worker-process.md) | BE | 20 | be §93–95, §109, §151; sol §7; arch §2 |
| 22 | [Job control: retry, cancel & human-readable progress](./phase-22-job-control-and-progress.md) | BE | 12, 21 | be §33, §34, §36, §37, §109, §153 |

### Part F — Source ingest

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 23 | [Upload validation & path-exclusion engine](./phase-23-upload-validation-exclusions.md) | BE | 12, 17 | be §10, §14–16; sol §4.1–4.2 |
| 24 | [Upload persistence: GridFS, SourceVersion, SourceFile](./phase-24-upload-persistence.md) | BE | 20, 23 | be §10–13, §92; sol §4.3 step 1, §4.5 |
| 25 | [Worker ingest stages S0–S2](./phase-25-ingest-stages-s0-s2.md) | BE | 21, 24 | be §15, §31–34, §38; sol §4.6 |
| 26 | [Workspace materialization, document sections & full-text index](./phase-26-workspace-and-document-index.md) | BE | 25 | be §22, §23, §57; sol §4.3 step 3 |
| 27 | [CodeGraph adapter: writer lock, index/sync, validation](./phase-27-codegraph-adapter.md) | BE | 05, 26 | be §23, §93, §94, §139; sol §4.3 step 4, §4.4 |
| 28 | [Knowledge publish, health, recovery & Q&A gate](./phase-28-knowledge-publish-and-health.md) | BE | 27 | be §26–30, §85, §111, §112, §144; sol §4.3 step 5, §4.6 |
| 29 | [Source diff, re-ingest, retry & resume](./phase-29-source-diff-and-reingest.md) | BE | 28 | be §11–13, §21, §27, §37, §83; sol §4.7–4.8 |

### Part G — Repository connection

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 30 | [Repository probe & credential security](./phase-30-repository-probe.md) | BE | 12, 17 | be §17–19, §148; fe §10, §12–14 |
| 31 | [Repository attach, branch selection & credential lifecycle](./phase-31-repository-attach-and-credentials.md) | BE | 30 | be §17, §19, §20; fe §11, §14A |
| 32 | [Repository sync scheduler & sync job](./phase-32-repository-sync.md) | BE | 29, 31 | be §21, §110; sol §4.8B |

### Part H — Frontend ingest, repository and processing slices

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 33 | [Frontend source upload slice](./phase-33-frontend-source-upload.md) | FE | 19, 24 | fe §15–19 |
| 34 | [Frontend repository connection slice](./phase-34-frontend-repository-connect.md) | FE | 19, 31 | fe §10–14, §14A |
| 35 | [Frontend processing center & persistent status slice](./phase-35-frontend-processing-center.md) | FE | 19, 22 | fe §20–28, §89, §90 |
| 36 | [Frontend sources & project health slice](./phase-36-frontend-sources-and-health.md) | FE | 19, 28, 31 | fe §29, §30, §74, §81A |

### Part I — Knowledge browse, search, preview

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 37 | [Knowledge browse API](./phase-37-knowledge-browse-api.md) | BE | 28 | be §24, §25, §85, §130; sol §11.1 |
| 38 | [Project search API & "ask about this" resolution](./phase-38-search-api.md) | BE | 26, 28 | be §131, §132; sol §11.2 |
| 39 | [Source preview API, change summary & documentation conflicts](./phase-39-source-preview-and-changes.md) | BE | 26, 29 | be §83, §84, §128, §133, §134; sol §11.3 |
| 40 | [Frontend knowledge, search & changes slice](./phase-40-frontend-knowledge-and-search.md) | FE | 19, 37, 38, 39 | fe §66–74, §100 |

### Part J — Conversations and the Q&A engine

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 41 | [Conversation & message models with lifecycle APIs](./phase-41-conversation-models.md) | BE | 17, 18 | be §40, §41, §45, §48, §140–143; sol §10.2 |
| 42 | [Conversation search & automatic titles](./phase-42-conversation-search-and-titles.md) | BE | 41 | be §49, §50; sol §10.3–10.4 |
| 43 | [Context budgeter & tokenizer parity](./phase-43-context-budgeter.md) | BE+EVAL | 02 | be §43, §44, §70; sol §1.2 |
| 44 | [Conversation summarization, pinned facts & context metrics](./phase-44-summarization-and-context-metrics.md) | BE | 43 | be §42, §43, §44, §58, §59; fe §36–38 |
| 45 | [LLM client & bounded inference queue](./phase-45-llm-client-and-queue.md) | BE | 43 | be §65, §68, §69; sol §2.1, §5.3 |
| 46 | [Agent tools](./phase-46-agent-tools.md) | BE | 26, 27, 43 | be §22, §57, §133; sol §5.5 |
| 47 | [LangGraph workflow: understand, routing & checkpoints](./phase-47-langgraph-understand.md) | BE | 44, 45 | be §51, §52, §56, §58; sol §5.2 node A |
| 48 | [LangGraph workflow: tool loop & run budgets](./phase-48-langgraph-tool-loop.md) | BE | 46, 47 | be §57, §66, §70; sol §5.2 node C, §5.6 |
| 49 | [LangGraph workflow: draft, verify & persist](./phase-49-langgraph-draft-verify-persist.md) | BE | 48 | be §60–64, §67, §113, §146; sol §5.2 nodes D–F |
| 50 | [Chat SSE endpoint & stream lifecycle](./phase-50-chat-sse-endpoint.md) | BE | 12, 49 | be §65, §96, §119, §120; sol §5.1 |
| 51 | [Queued questions during knowledge updates](./phase-51-queued-questions.md) | BE | 28, 50 | be §93–95, §144; sol §4.8, §5.8 |
| 52 | [Clarification API: set delivery, answers & resume](./phase-52-clarification-api.md) | BE | 47, 50 | be §53–55; sol §5.4 |
| 53 | [Message edit with downstream replace & response retry](./phase-53-message-edit-and-retry.md) | BE | 50 | be §46, §47; sol §10.1 — ADR 0036 `editMessage` / `retryMessage` locked |

### Part K — Frontend chat slices

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 54 | [Frontend conversations slice](./phase-54-frontend-conversations.md) | FE | 19, 41, 42 | fe §31–35, §39–44, §80, §106 |
| 55 | [Frontend streaming answer slice](./phase-55-frontend-streaming-answer.md) | FE (+ small BE abort) | 50, 53, 54 | fe §45, §55–64; ADR 0037 |
| 56 | [Frontend clarification slice](./phase-56-frontend-clarification.md) | FE | 52, 55 | fe §47–52 |
| 57 | [Frontend evidence, metrics, abstain & version notices](./phase-57-frontend-evidence-and-metrics.md) | FE | 39, 49, 55 | fe §61, §64A, §66–70, §97, §108 |

### Part L — Platform operations

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 58 | [Notifications](./phase-58-notifications.md) | BE+FE | 13, 28, 32 | be §98, §108; fe §87; sol §12.1 |
| 59 | [Usage tracking](./phase-59-usage-tracking.md) | BE+FE | 13, 28, 49 | be §68, §99, §100; fe §86; sol §12.2 |
| 60 | [Retention policies & scheduled cleanup](./phase-60-retention.md) | BE+FE | 10, 13, 21, 41 | be §101–103; fe §86A; sol §12.3 |
| 61 | [Security & tenant-isolation hardening pass](./phase-61-security-hardening.md) | BE | 12, 18, 28, 50 | be §16, §88–90, §114, §115, §147–150; fe §107 |

### Part M — Final quality gates

| # | Phase | Layer | Depends on | Primary requirements |
|---|---|---|---|---|
| 62 | [Observability & reliability pass](./phase-62-observability-and-reliability.md) | BE | 61 | be §104–110, §151–154 |
| 63 | [End-to-end Playwright suite & CI pipeline](./phase-63-e2e-and-ci.md) | BE+FE | all | be §155; fe §102; rules testing-standards, test-coverage |

---

## 7. Phase document template

Every `phase-NN-*.md` file uses exactly these sections, in this order.

```markdown
# Phase NN — <Title>

- **Layer:** BE | FE | BE+FE | EVAL | DOC
- **Depends on:** Phase NN, NN (or "—")
- **Unblocks:** Phase NN, NN
- **Size:** 1–2 days
- **Requirements covered:** backend/requirments.md §…; frontend/requirments.md §…;
  backend/solution.md §…; docs/architecture.md §…

## 1. Goal
Two to four sentences in plain language: what exists after this phase that did not before,
and how someone can see it working.

## 2. Why this phase is here
Dependency rationale — what it unblocks, and why it cannot come earlier or later.

## 3. Scope
### In scope
### Out of scope (owner phase)

## 4. Design
The actual approach: modules, data flow, state machines, algorithms, failure handling.
Decisions must trace to solution.md / architecture.md or be listed in section 12.

## 5. Data model changes
Collections, fields, types, indexes, and the mandatory `status: 'A' | 'D'` field. "None" is a
valid answer.

## 6. API contract — PROPOSED (needs approval before implementation)
Method, path, required permission, request shape, response shape, error codes.

## 7. Configuration & environment variables
Only values that must differ per environment go in `.env`. Tunables are named constants in
the consuming module (`.cursor/rules/env-config.mdc`). "None" is a valid answer.

## 8. Files to create or change
Path-by-path list with a one-line purpose for each.

## 9. Tests (≥ 80% line and branch)
Unit cases, integration cases, and the unhappy paths that must be covered.

## 10. Definition of Done
Checklist. Every box must be tickable by inspection.

## 11. Documentation & ADR updates

## 12. Risks & open questions
Anything that must be asked rather than assumed.
```
