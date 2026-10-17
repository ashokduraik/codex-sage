# E2E tests (Playwright)

Cross-service **user journeys** against a live local stack. Agent rules: [`AGENTS.md`](./AGENTS.md). Journey catalog: [`workflows.md`](./workflows.md).

Playwright does **not** start Mongo, the API, Vite, or the worker. GitHub Actions is **not** part of this suite (Phase 63).

---

## Quick start

```bash
cp tests/e2e/.env.example tests/e2e/.env
# Optional: set E2E_PRIVATE_REPO_URL and E2E_GITHUB_TOKEN for private-repo attach

# MongoDB 8 replica set must already be running (docs/mongodb-setup.md)
npm run dev   # API, worker, and Vite

npm run playwright:install   # first time — CDN timeouts; uses Google CFT
# npx playwright install chromium  # same result once cache is populated
npm run test:e2e
```

Set `E2E_SKIP=1` in `.env` to skip live-stack journey specs without failing.

Configuration: [`tests/e2e/.env`](./.env) (copy from [`.env.example`](./.env.example)). Never commit `.env`.

---

## What `npm run test:e2e` does

1. Loads `tests/e2e/.env` (Playwright config + global-setup).
2. [`global-setup.js`](./global-setup.js) — [`validateE2eEnv`](./helpers/validate-e2e-env.js), then probes `GET /health` and `/login`.
3. Runs journey specs under [`web/`](./web/).
4. Each project-creating journey soft-deletes its `E2E-*` projects in `afterAll` (including after a failed serial step).

Private-repo tests **skip** when `E2E_PRIVATE_REPO_URL` or `E2E_GITHUB_TOKEN` is blank. They do not fail the run.

```bash
npm run test:e2e -- journey-auth
npx playwright test tests/e2e/web -c tests/e2e/playwright.config.js
npx playwright test -g "valid login" -c tests/e2e/playwright.config.js
npm run test:e2e:env
```

---

## Environment variables

| Variable                                 | Required | Purpose                                                       |
| ---------------------------------------- | -------- | ------------------------------------------------------------- |
| `E2E_BASE_URL`                           | No       | Web app (default `http://localhost:5173`)                     |
| `E2E_API_URL`                            | No       | API origin (default `http://localhost:3000`)                  |
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | No       | Bootstrap admin (defaults match ADR 0011)                     |
| `E2E_PUBLIC_REPO_URL`                    | No       | Override default public repo (`sindresorhus/is-docker`)       |
| `E2E_REPO_BRANCH`                        | No       | Unused default `main` (dialog uses the probed default branch) |
| `E2E_PRIVATE_REPO_URL`                   | No       | Private Git URL; skip private attach when blank               |
| `E2E_GITHUB_TOKEN`                       | No       | Token for the private repo; skip when blank                   |
| `E2E_SKIP`                               | No       | `1` skips journey specs                                       |
| `E2E_HEADLESS`                           | No       | `1` for headless browser                                      |

---

## Specs & helpers

| Journey                     | Spec                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Auth                        | `web/journey-auth.spec.js`                                                         |
| Project lifecycle           | `web/journey-project-lifecycle.spec.js`                                            |
| Repository onboarding       | `web/journey-repository-onboarding.spec.js`                                        |
| ZIP ingest + knowledge      | `web/journey-zip-ingest-and-knowledge.spec.js`                                     |
| Admin users / roles / audit | `web/journey-admin.spec.js` (creates roles in the UI; invite requires user `code`) |

Helpers live in [`helpers/`](./helpers/). Chat, conversations, notifications, usage, and retention are **not** covered — those UIs are not on the real API yet.
