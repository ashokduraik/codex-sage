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
if ready/partial → Knowledge facets
if failed → Retry on processing
private attach on a second project (skip without env)
```

- **Spec:** [`web/journey-repository-onboarding.spec.js`](./web/journey-repository-onboarding.spec.js)
- One repository per project — public and private are separate projects
- `afterAll` soft-deletes every project this journey created

### 4. ZIP ingest + knowledge via UI — **done**

```
create as Upload
reject non-zip
upload sample ZIP → Processing History
wait health terminal
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

### Not in this suite

Chat / SSE, conversations, notifications, admin usage / retention / org-projects (mock or later phases). CI remains Phase 63.

---

## Test matrix

| Journey                | Needs worker      | Needs private repo env       |
| ---------------------- | ----------------- | ---------------------------- |
| Auth                   | No                | No                           |
| Project lifecycle      | No                | No                           |
| Repository onboarding  | Yes (ingest wait) | Only the private-attach test |
| ZIP ingest + knowledge | Yes               | No                           |
| Admin                  | No                | No                           |
