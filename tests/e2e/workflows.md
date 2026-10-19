# E2E user workflows

Run: `npm run test:e2e` (stack must be up — see [`README.md`](./README.md)). Agent rules: [`AGENTS.md`](./AGENTS.md).

Private-repo attach **skips** when `E2E_PRIVATE_REPO_URL` or `E2E_GITHUB_TOKEN` is blank.

---

## Journeys

### 1. Auth via UI — **done**

```
invalid password → role=alert
valid login → Home
Sign out → /login
```

- **Spec:** [`web/journey-auth.spec.js`](./web/journey-auth.spec.js)
- Bootstrap admin from `.env` (defaults `admin@localhost` / `abc123`)

### 2. Project lifecycle via UI — **done**

```
empty name / no source type → Create stays disabled
create (Upload path, cancel upload) → card + search
open → archive → restore → delete-with-preview
```

- **Spec:** [`web/journey-project-lifecycle.spec.js`](./web/journey-project-lifecycle.spec.js)
- Shared `E2E-*` name; last step exercises delete-with-preview
- `afterAll` soft-deletes the project if that step was skipped after a failure

### 3. Repository onboarding via UI — **done**

```
create as Connect repository
empty URL → Connect disabled
invalid host → probe error
attach public repo → Sources
wait job History + health terminal
if ready/partial → activity log Source validated (N) matches Health “N files mapped” → Knowledge facets
if failed → Retry on processing
private attach on a second project (skip without env)
```

- **Spec:** [`web/journey-repository-onboarding.spec.js`](./web/journey-repository-onboarding.spec.js)
- One repository per project — public and private are separate projects
- Default public repo remains `sindresorhus/is-docker` (not the chat dogfood repo)
- `afterAll` soft-deletes every project this journey created

### 4. ZIP ingest + knowledge via UI — **done**

Click **Fill from README** on Overview after ingest (API + LLM; worker does not call the LLM). Sample ZIP includes root `README.md` (3 files).

```
create as Upload
reject non-zip
upload sample ZIP → Processing History
wait health terminal
if ready/partial → activity log Source validated (2) matches Health “2 files mapped”
if ready/partial → Knowledge + Search + preview
second ZIP → Changes path diffs
```

- **Spec:** [`web/journey-zip-ingest-and-knowledge.spec.js`](./web/journey-zip-ingest-and-knowledge.spec.js)
- Worker required. Timeout fails with a start-worker message.
- `afterAll` soft-deletes the created project

### 5. Admin identity + audit via UI — **done**

```
Users list includes bootstrap admin (code ADMIN)
Create custom roles on Roles & Permissions, edit permissions
create invited user (with code) → set password → edit roles → deactivate/activate
Audit filter User created
login as that user → forced change password → Sign out
admin removes the user
```

- **Spec:** [`web/journey-admin.spec.js`](./web/journey-admin.spec.js)
- New users use `@example.com` (`.localhost` fails create-user validation)

### 6. Chat ask via ZIP — **done**

```
create Upload project → sample ZIP
wait job History + health terminal
if ready/partial → Chat:
  strict grounded ask (hello.js + value) + evidence inspect
  multi-turn follow-up without repeating the constant name
  leave Overview / reopen → continue
  abstain on fictional module
  New Chat isolation
  edit + resubmit
  clarification on ambiguous ask
  Stop cancels generation
  second ZIP while ask → queued path then grounded answer
  archive / restore / rename / search → continue ask
  Search “Ask about this” on fixture token → Chat attachment → grounded
  greeting + general-knowledge routing
```

- **Spec:** [`web/journey-chat.spec.js`](./web/journey-chat.spec.js)
- Worker + LLM required. Grounded asks **fail** on abstain when health is ready/partial.
- `afterAll` soft-deletes the created project

### 7. Chat ask via git-synced prepayment-advisor — **done**

```
create Connect repository → attach ashokduraik/prepayment-advisor
wait job History + health terminal
if ready/partial → Chat:
  functional EMI product-behavior ask → Sources cite loan.utils.ts
  technical EMI implementation ask → functions + loan.utils.ts
  multi-turn follow-up (no “EMI” in turn 2) keeps formula context
  leave / reopen continue
  ambiguous payments question → clarification UI
```

- **Spec:** [`web/journey-chat-repo.spec.js`](./web/journey-chat-repo.spec.js)
- Public repo; default `https://github.com/ashokduraik/prepayment-advisor.git` (`E2E_CHAT_REPO_URL` override)
- Worker + LLM + network to GitHub required
- `afterAll` soft-deletes the created project

### Not in this suite

Notifications, admin usage / retention / org-projects (mock or later phases). CI remains Phase 63.

---

## Test matrix

| Journey                       | Needs worker      | Needs private repo env       | Needs LLM             | Needs public git |
| ----------------------------- | ----------------- | ---------------------------- | --------------------- | ---------------- |
| Auth                          | No                | No                           | No                    | No               |
| Project lifecycle             | No                | No                           | No                    | No               |
| Repository onboarding         | Yes (ingest wait) | Only the private-attach test | No                    | Yes (is-docker)  |
| ZIP ingest + knowledge        | Yes               | No                           | Fill-from-README only | No               |
| Chat ask (ZIP)                | Yes               | No                           | Yes                   | No               |
| Chat ask (prepayment-advisor) | Yes               | No                           | Yes                   | Yes (chat repo)  |
| Admin                         | No                | No                           | No                    | No               |
