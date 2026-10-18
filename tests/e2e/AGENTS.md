# AGENTS.md — tests/e2e

Local rules for Playwright cross-service journeys. Root [`/AGENTS.md`](../../AGENTS.md) also applies.

## What E2E covers today

- **Auth:** invalid password, bootstrap login, sign out.
- **Project lifecycle:** create validation, create without source, search, archive, restore, soft-delete.
- **Repository onboarding:** empty/invalid URL, public attach, optional private attach, ingest wait, knowledge when ready/partial.
- **ZIP ingest + knowledge:** reject non-zip, upload fixture (includes root README), processing/health wait, Overview Fill from README (API + LLM), search/preview, second ZIP → changes.
- **Admin:** users (code column), create/edit roles in the UI, invite + password + roles + status, audit `user.create`, forced password change, remove user. Do not click seeded Member/Viewer — create roles in the journey.

Catalog + matrix: [`workflows.md`](./workflows.md). Runbook: [`README.md`](./README.md).

## Do

- Install browsers with `npm run playwright:install` when `npx playwright install chromium` times out on `cdn.playwright.dev`.
- Add **journey specs** (user flows), not widget micro-tests. Prefer one serial `describe` per journey.
- Put reusable steps in [`helpers/`](./helpers/).
- Validate env in [`global-setup.js`](./global-setup.js) via [`validate-e2e-env.js`](./helpers/validate-e2e-env.js).
- Soft-delete every project the journey created in `test.afterAll` via `cleanupCreatedProjects` — not only on the happy path.
- Skip private-repo tests with `test.skip` when URL/token are missing — do not fail the whole run.
- Document new env vars in [`.env.example`](./.env.example) and mirror to `.env` (never commit `.env`).
- Match product UI semantics (disabled buttons vs HTML `required`).
- Update [`workflows.md`](./workflows.md) and [`README.md`](./README.md) when adding journeys or env keys.
- Use JavaScript only. Selectors: `getByRole` / `getByLabel` / existing ids. No `data-testid`.

## Don't

- Don't start the stack from Playwright (`webServer`, Docker, `start-stack.js`).
- Don't add GitHub Actions in this suite — that remains Phase 63.
- Don't seed projects or users via API in journey specs.
- Don't cover chat, conversations, notifications, usage, or retention (not real-API UI).
- Don't click **Ask about this** (navigates to mock chat).
- Don't change the bootstrap admin password.
- Don't invent knowledge when ingest health is `Failed`.
- Don't commit secrets or print `.env` contents.

## Env model

| Repo    | Source                                                                                                   | Token                         |
| ------- | -------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Public  | `DEFAULT_PUBLIC_REPO_URL` in `helpers/env.js` (`sindresorhus/is-docker`); optional `E2E_PUBLIC_REPO_URL` | None                          |
| Private | `E2E_PRIVATE_REPO_URL` (optional)                                                                        | `E2E_GITHUB_TOKEN` (optional) |

`E2E_SKIP=1` — log skip line in global-setup; journey specs use `test.skip(skipLiveStack, …)`.

## Before finishing

- Run `npm run test:e2e:env`.
- Run `npm run test:e2e` with the stack up (or document why a change is docs-only / skip).
