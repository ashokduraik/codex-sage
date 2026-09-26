# Phase 63 — End-to-end Playwright suite & CI pipeline

- **Layer:** BE+FE
- **Depends on:** All prior phases in `docs/plan/README.md` §6 (product slices through phase 62)
- **Unblocks:** Ongoing delivery — every later change runs through automated lint, unit/integration
  tests, coverage gate, and the agreed Playwright smoke/critical paths
- **Size:** 1–2 days (initial CI + first E2E paths; expanding coverage is follow-on work inside
  the same suite)
- **Requirements covered:** `backend/requirments.md` §155 (final end-to-end backend flow);
  `frontend/requirments.md` §102 (core UX loop); plan decisions **D10** (CI in this phase),
  **D11** (no containerisation or production deploy), **D12** (E2E last), **D16** (external
  Mongo); [ADR 0009](../adr/0009-integration-tests-external-mongo.md); `.cursor/rules/testing-standards.mdc`,
  `test-coverage.mdc`

## 1. Goal

After this phase every push and pull request runs **GitHub Actions** that lint the backend and
frontend, execute Vitest unit and integration suites against the **external MongoDB 8 replica set**
with database name `codex_sage_test`, and **fail the build** if line or branch coverage drops below
**80%** for the packages the workflow measures. A **Playwright** suite exercises the real stack
(API + worker + built or dev-served frontend) through **PROPOSED** critical paths aligned with
backend §155 and frontend §102 — without claiming the full UX loop when CI lacks repo credentials,
CodeGraph, or Ollama. Operators see a green CI only when honesty constraints are met; skipped paths
are explicit in workflow config and documented here, not silent. Locally, `npm run test:e2e` (or
the chosen script name) mirrors CI when Mongo and optional services are available.

## 2. Why this phase is here

Decisions D10 and D12 place CI and Playwright **after** feature phases so each slice already ships
colocated tests at ≥ 80% coverage; this phase wires the **aggregate gate** and the first cross-app
journeys. It cannot run earlier: mocks still drive much of the UI until phases 13–57 land, and
integration tests assume the phase 03 harness on external Mongo (ADR 0009). It is the final quality
gate before ongoing maintenance — not a production release (D11).

## 3. Scope

### In scope

- **GitHub Actions workflow(s)** under `.github/workflows/`: install, lint, test, coverage report,
  upload coverage artifact (optional), Playwright job — no deploy step.
- **Coverage enforcement:** v8 (or existing Vitest config) thresholds **80% lines and 80% branches**
  for `backend/` and `frontend/` as configured in each package; fail CI on regression.
- **Integration test env:** `MONGODB_URI` (or project-standard name from phase 01/03) pointing at
  the shared replica set; **database name `codex_sage_test`**; fail closed if URI missing (ADR 0009).
  **`mongodb-memory-server` is not used.**
- **Playwright** project config, shared fixtures (auth storage, API base URL, web base URL), and
  test data helpers that seed via API using bootstrap org/admin constants (ADR 0011), not hardcoded
  secrets in the repo.
- **Process orchestration for E2E:** start API, worker, and frontend for tests (Node scripts — not
  Docker — per D11); health-wait until `GET /health` (and worker liveness if phase 62 added it)
  before tests run.
- **Critical paths (PROPOSED — §6):** document and implement the minimum set agreed with product;
  optional paths gated on CI secrets / Ollama / CodeGraph availability.
- **CI documentation:** root or `docs/` note listing required secrets, optional skips, and how to
  run E2E locally.

### Out of scope (owner phase or plan-wide)

- Production deployment, Kubernetes, PM2 fleet docs, CDN, TLS termination — **D11**.
- Docker Compose or container images for CI — **D11** (unless superseding ADR explicitly approved).
- `mongodb-memory-server` or mock-Mongo "integration" — **D16 / ADR 0009**.
- Full frontend §102 loop **as a mandatory CI gate** when LLM or repo connect cannot run — must be
  **asked** (§12); do not silently assert chat answers or GitHub sync in default CI.
- Live customer-database query branch — README §5.
- Performance/load testing and SLO enforcement — **Phase 05** unwritten.
- Replacing unit tests in earlier phases — they remain colocated; CI runs them.

## 4. Design

### 4.1 CI pipeline shape

```text
job: lint
  backend: npm run lint
  frontend: npm run lint

job: test-backend
  env: MONGODB_URI → replica set; DB name codex_sage_test (harness from phase 03)
  npm test -- --coverage
  enforce ≥ 80% line + branch (vitest.config)

job: test-frontend
  npm test -- --coverage
  enforce ≥ 80% line + branch

job: e2e (needs: lint + test-backend + test-frontend)
  start API + worker + frontend (scripts)
  npx playwright test
  upload playwright-report on failure
```

Parallelize lint and unit jobs where runner minutes allow; E2E depends on green unit gates. No
deploy stage.

### 4.2 Mongo and data hygiene (ADR 0009, D16)

- Same **external MongoDB 8 replica set** as development; **never** the default dev database name
  used for manual work unless explicitly the same URI with `codex_sage_test` substituted.
- Phase 03 harness patterns: `beforeAll` connect + `syncSchemaIndexes`; `afterEach` or suite
  teardown drops test collections or truncates scoped data — **must not** wipe non-test DBs.
- E2E may reuse harness helpers or a thin `e2e/seed.js` that calls public APIs.

### 4.3 Playwright environment

| Variable | Purpose |
|---|---|
| `E2E_API_BASE_URL` | e.g. `http://127.0.0.1:3001/api/v1` |
| `E2E_WEB_BASE_URL` | e.g. `http://127.0.0.1:5173` or preview port |
| `MONGODB_URI` | Replica set connection string |
| `E2E_MONGODB_DB_NAME` | Default `codex_sage_test` if URI does not embed db name |

Auth: login through UI with bootstrap admin from constants (phase 06/07) — password supplied via
**CI secret** (`E2E_ADMIN_PASSWORD` PROPOSED), not committed. Session: storageState fixture after
one login.

### 4.4 Critical paths — PROPOSED (needs approval before implementation)

Paths below map to backend §155 and frontend §102. **Mandatory in default CI** only after §12
confirms which optional legs run on GitHub-hosted runners.

| ID | Journey | Asserts (high level) | CI dependency |
|---|---|---|---|
| P1 | **Sign-in** | Login form → projects shell; session persists | Bootstrap user + `E2E_ADMIN_PASSWORD` |
| P2 | **Create project** | Dialog → project appears in list/detail | P1 |
| P3 | **Upload ZIP → processing → health** | Upload fixture zip → job/events or processing UI → project health/lifecycle reflects processing then ready/partial (not fake %) | Worker running; ingest through phase 28; fixture zip in repo |
| P4 | **Repository probe/connect** (optional) | Connect dialog → probe success → attach | **CI secrets** for token + test repo URL — **skip if absent (§12 Q1)** |
| P5 | **Ask a question** (optional) | Open chat → send question → terminal SSE `done` or structured abstain/error | **Ollama** (or configured LLM) reachable; knowledge ready — **skip if absent (§12 Q2)** |
| P6 | **Knowledge browse smoke** (optional) | Explorer/search returns backend-driven nodes only | Phases 37–40; may run without LLM if P5 skipped |

**Do not** claim full §102 loop in CI README unless P3–P5 all run on the default workflow.
Partial pipeline (P1–P3) is a valid MVP gate if product approves.

### 4.5 Skips and honesty

- Use Playwright `test.skip(condition, reason)` or separate projects `@smoke` vs `@full` — not
  empty passes. Skipped tests log a clear reason (`no E2E_GITHUB_TOKEN`, `no LLM_BASE_URL`).
- Frontend must not show fabricated progress; E2E waits on **authoritative** API/job state (phase
  22/35), with timeouts as named constants in the Playwright helpers.

### 4.6 CodeGraph in CI

Full ingest through S4 may require CodeGraph native tooling. **PROPOSED:** use the smallest fixture
zip that completes S0–S3 without graph if graph fails in CI, **or** skip to `partially_available`
health — **ask** whether CI installs CodeGraph or uses a prebuilt graph fixture (§12 Q3). Do not
invent graph output.

## 5. Data model changes

**None.** E2E uses existing APIs and the test database only. Seed data is created through HTTP and
 torn down by harness rules.

## 6. API contract — PROPOSED (needs approval before implementation)

This phase adds **no product API**. It **consumes** approved routes from earlier phases. E2E helpers
depend on these shapes (already PROPOSED or implemented elsewhere):

| Step | Method / path | Permission | Notes |
|---|---|---|---|
| Login | `POST /api/v1/auth/login` | — | Body `{ email, password }`; sets refresh cookie |
| Create project | `POST /api/v1/projects` | `projects.create` | Returns project id |
| Upload source | `POST /api/v1/projects/:projectId/sources` | `sources.upload` | Multipart zip + `Idempotency-Key` |
| Job status | `GET /api/v1/projects/:projectId/jobs/:jobId` or list | `jobs.view` | Phase 20/22 |
| Project health | `GET /api/v1/projects/:projectId` or health field | `projects.view` | `knowledgeHealth` / lifecycle |
| Chat (optional P5) | `POST /api/v1/conversations/.../messages` | `chat.ask` | SSE — Playwright may use APIRequest or browser |

Confirm exact paths against phase documents at implementation time; update this table if contracts
change after approval.

## 7. Configuration & environment variables

Per-environment only (document in root and `backend/.env.example`, `frontend/.env.example`; mirror
`.env` per `env-example-sync.mdc`):

| Variable | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | Yes (CI + integration) | External replica set |
| `E2E_ADMIN_PASSWORD` | Yes for P1–P3 | Bootstrap admin password for login |
| `E2E_API_BASE_URL` | E2E | API base including `/api/v1` |
| `E2E_WEB_BASE_URL` | E2E | Vite dev or preview URL |
| `E2E_MONGODB_DB_NAME` | Optional | Default `codex_sage_test` |
| `E2E_GITHUB_TOKEN` / `E2E_TEST_REPO_URL` | Optional P4 | Repository connect path |
| `LLM_BASE_URL` / `LLM_MODEL_ID` / `LLM_CONTEXT_CAPACITY` | Optional P5 | Chat path |

Playwright timeouts, poll intervals for job completion, and SSE read deadlines are **named
constants** in `e2e/` helpers, not env vars.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `E2E_JOB_WAIT_TIMEOUT_MS` | TBD after approval | `e2e/constants.js` | Max wait for ingest job terminal state |
| `E2E_SSE_DONE_TIMEOUT_MS` | TBD after approval | `e2e/constants.js` | Max wait for chat stream terminal event |

Do not invent aggressive timeouts without product input (§12 Q4).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `.github/workflows/ci.yml` | **New:** lint, test, coverage, Playwright jobs |
| `backend/vitest.config.js` | **Verify/extend:** coverage thresholds 80/80 |
| `frontend/vitest.config.js` | **Verify/extend:** coverage thresholds 80/80 |
| `package.json` (root and/or packages) | **Extend:** `test:e2e`, `ci:*` scripts if needed |
| `playwright.config.js` | **New:** projects, baseURL, reporters, trace on failure |
| `e2e/fixtures/auth.js` | **New:** login + storageState |
| `e2e/fixtures/project.js` | **New:** create project helper |
| `e2e/fixtures/upload.js` | **New:** zip upload helper + fixture path |
| `e2e/tests/smoke/sign-in.spec.js` | **New:** P1 |
| `e2e/tests/smoke/create-project.spec.js` | **New:** P2 |
| `e2e/tests/smoke/upload-and-health.spec.js` | **New:** P3 |
| `e2e/tests/optional/repo-connect.spec.js` | **New:** P4 — conditional skip |
| `e2e/tests/optional/chat-ask.spec.js` | **New:** P5 — conditional skip |
| `e2e/scripts/start-stack.js` | **New:** spawn API, worker, web; wait for health |
| `e2e/fixtures/sample-project.zip` | **New:** minimal valid zip (phase 23 rules) |
| `docs/testing-ci.md` or section in `AGENTS.md` | **New:** how to run CI locally, secrets, skips |
| `.gitignore` | Already ignores `playwright-report/` — confirm |

Use `.js` for Playwright tests and helpers (no TypeScript sources).

## 9. Tests (≥ 80% line and branch)

### Unit / integration (existing packages)

- CI runs full backend and frontend Vitest suites; this phase must not reduce coverage below 80%
  line and branch on touched config files (`playwright.config.js`, `e2e/scripts/*` if unit-tested).

### Playwright (E2E)

- **P1:** Invalid password shows API error message (role=alert); valid login reaches projects.
- **P2:** Create project validation error + happy path.
- **P3:** Upload fixture → wait for job terminal state or lifecycle `knowledge_ready` /
  `partially_available` / explicit failed with retry UI — never infinite spinner.
- **P4 (if enabled):** Probe failure shows safe copy; success path reaches connected state without
  displaying token.
- **P5 (if enabled):** Message completes with `done` or visible abstain/error — no assertion on
  answer text matching a golden string (LLM non-deterministic).

### Unhappy paths

- CI fails when `MONGODB_URI` unset (integration job), not skip silently.
- E2E startup: API down → start script exits non-zero before Playwright runs.
- Cross-tenant: optional API-level test in backend suite (phase 61) remains in Vitest; E2E uses
  single-org bootstrap only.

## 10. Definition of Done

- [ ] GitHub Actions runs on push/PR: lint + backend tests + frontend tests + coverage gates ≥ 80%
      line and branch.
- [ ] Integration tests use external MongoDB 8 replica set and `codex_sage_test`; no
      `mongodb-memory-server`.
- [ ] Playwright **smoke** paths (at minimum P1–P3 after §12 approval) pass on a runner with Mongo,
      API, worker, and frontend.
- [ ] Optional paths P4/P5 skip with documented reasons when secrets/Ollama absent — not fake pass.
- [ ] No containerisation or production deploy steps in workflow (D11).
- [ ] Required CI secrets documented in `.env.example` keys only; no secret values committed.
- [ ] `docs/` (or AGENTS) explains local E2E setup and alignment with ADR 0009.
- [ ] `npm run lint` and full test suite pass; new `e2e/` and workflow files meet coverage rules
      where applicable.

## 11. Documentation & ADR updates

- Add `docs/testing-ci.md` (or equivalent) describing workflows, Mongo requirement, skips, and
  bootstrap credentials — truthful about which §102 steps CI covers.
- Reference ADR 0009 in that doc; no new ADR unless CI adopts a new Mongo fixture strategy (§12 Q3).
- Update `docs/plan/README.md` §3 "Where the codebase stands" only if maintainers track CI there —
  **not required** for this phase file alone.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Repository connect in CI.** If no `E2E_GITHUB_TOKEN` (or GitLab equivalent) is available, should
   P4 be permanently skipped on default GitHub-hosted CI, or is a self-hosted runner with secrets
   mandatory for merge?
2. **LLM in CI.** Should P5 run against a real Ollama service in CI, use a stub LLM adapter for E2E
   only, or stay skipped until ops provides Ollama — **do not silently claim "Ask anything" in CI**.
3. **CodeGraph on the runner.** Does ingest E2E require installing `@colbymchenry/codegraph` and
   running index on fixture zip, or is reaching S3 + mocked S4 sufficient for the smoke gate?
4. **Timeout budgets.** How long may P3 wait for ingest on CI (small zip vs full pipeline)?
5. **Coverage scope.** One combined threshold for monorepo vs separate backend/frontend jobs — which
   packages fail the PR if only one regresses?
6. **Worker in CI.** Must the workflow start `npm run dev:worker` (or production worker entry) for
   P3, or is API-only polling acceptable for the first slice?
7. **Frontend server mode.** Vite dev vs `vite preview` after build — which matches CI stability
   requirements?
8. **Full §102 gate.** Which subset of P1–P6 is **required for merge** vs nightly `@full` project?
