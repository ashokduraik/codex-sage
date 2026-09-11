# Phase 06 — Tenancy & identity models with bootstrap seed

- **Layer:** BE
- **Depends on:** Phase 03 (base schema, repository conventions, integration-test harness)
- **Unblocks:** Phase 07, 08, 09, 10, 11, 17, 18 — every tenant-scoped collection and route
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §3 (multi-tenancy), §4 (organization),
  §5 (user management), §6 (role vocabulary), §89 (data isolation);
  `backend/solution.md` §8.1 (domain model), §8.2 (built-in roles), §6 (Mongoose usage);
  `docs/architecture.md` §3 (what lives where)

## 1. Goal

After this phase MongoDB holds the four collections every other tenant-scoped feature hangs off:
`organizations`, `users`, `roles`, `memberships`. Each is a Mongoose model built on the Phase 03
base schema (row `status: 'A' | 'D'`, UTC timestamps, `createdBy` / `updatedBy`) with
tenant-scoped repositories for `users` / `roles` / `memberships` whose every read and write
takes an `orgId`, plus tenant-scoped unique indexes that make a duplicate email inside one
organization impossible while leaving that same email free in another organization.
`organizations` uses the base schema but **opts out** of the tenant `orgId` plugin (its `_id`
*is* the org id).

A controlled `npm run bootstrap` command in `backend/` creates the first organization, its four
built-in roles, and its first administrator. Running it twice against the same database changes
nothing and exits `0`. There is still no HTTP route and no login — Phase 07 adds those.

## 2. Why this phase is here

Phase 07 needs a `User` document to authenticate, Phase 09 needs `Role` and `Membership` to
resolve permissions, and Phases 10, 11, 17 need an `orgId` that means something. Every
one of them would otherwise invent its own shape.

It cannot come earlier: Phase 03 owns the base schema helper, the soft-delete query defaults,
and the integration-test database harness that these models and their index assertions rely on.

It cannot come later: decision D6 removes public self-registration, so a seeded organization is
the only way any authenticated test or manual run of Phase 07 onward can exist at all.

## 3. Scope

### In scope

- `Organization`, `User`, `Role`, `Membership` Mongoose models and their indexes.
- Repositories for each, organization-scoped by construction.
- The built-in role set (`org_admin`, `project_admin`, `member`, `viewer`) and the storage rule
  that separates built-in roles from custom roles.
- A bootstrap seed command under `backend/` — idempotent, transactional, non-interactive-safe.
- `backend/.env.example` additions mirrored into `backend/.env`.

### Out of scope (owner phase)

- Password hashing, login, tokens, sessions — **Phase 07**.
- Password reset and temporary credentials — **Phase 08**.
- The permission catalog, permission resolution, route guards — **Phase 09**.
- Audit events for identity changes — **Phase 10**.
- Admin user/role/membership HTTP APIs — **Phase 11**.
- `ProjectMember` (the project ACL overlay) — **Phase 18**.

## 4. Design

### 4.1 Module layout

One module, `src/modules/identity/`, following the repo's `model + repository + tests` shape with
a single public surface (`index.js`). Nothing outside the module imports a model file directly;
later phases consume the repositories. Routes arrive in Phase 11 and live in the same module.

### 4.2 Row status versus domain lifecycle

Two different questions, two different fields, on `users` in particular:

| Field | Values | Meaning |
|---|---|---|
| `status` | `'A'` \| `'D'` | Row visibility. `'D'` = removed from the product (soft delete) |
| `userStatus` | `'active'` \| `'invited'` \| `'disabled'` | Whether this person may currently use the product |

`userStatus: 'disabled'` is a reversible administrative action (frontend §82 lists Activate and
Deactivate separately from Remove). `status: 'D'` is the removal. Nothing in the codebase may
overload one for the other, and no list query may return `status: 'D'` by default.

### 4.3 Built-in roles versus custom roles

Both live in the same `roles` collection, scoped to one organization, distinguished by two
fields:

```text
built-in role   → isBuiltIn: true,  builtInKey: 'org_admin' | 'project_admin' | 'member' | 'viewer'
                  permissions: []   (resolved from the code catalog at read time)
custom role     → isBuiltIn: false, builtInKey: undefined
                  permissions: ['projects.view', 'chat.ask', …]  (persisted)
```

Built-in roles are seeded per organization so a membership always points at a real document and
the admin UI can list all four. Their permission lists are **not** persisted: Phase 09 owns the
permission catalog, and resolving built-ins from code means adding a permission to `org_admin` in
a later phase is a code change, not a data migration across every tenant. Custom roles persist
their own array, validated against the Phase 09 catalog when Phase 11 starts creating them.

Built-in roles cannot be renamed, re-permissioned, or soft-deleted — the repository rejects any
write that targets a document with `isBuiltIn: true` outside the seed path.

### 4.4 Membership

`Membership` links one user to one organization with one or more `roleIds`. Solution §8.1 states
a user belongs to exactly one organization in the MVP, so the unique index on
`{ orgId, userId }` plus the user's own `orgId` are two expressions of the same
fact; the repository treats the `Membership` document as authoritative for roles and the user's
`orgId` as the tenant key.

### 4.5 Bootstrap seed

Invoked as `npm run bootstrap` in `backend/` (an `tsx` entry at `src/cli/bootstrap.js`), it loads
the same validated config as the API, connects to Mongo, runs inside a transaction (available per
decision D5), and disconnects. It is a command, not a route: there is no public signup (D6), and
no HTTP surface may ever create an organization from an unauthenticated request.

```text
1. read BOOTSTRAP_ORG_NAME, BOOTSTRAP_ORG_SLUG, BOOTSTRAP_ADMIN_EMAIL from validated config
2. start session + transaction
3. upsert organization by slug        → created | already present
4. upsert the four built-in roles     → created | already present
5. upsert admin user by (orgId,email) → created with userStatus 'invited'
6. upsert membership (admin → org_admin role)
7. commit; print a one-line summary with ids, no credentials
```

**Idempotency** is enforced at three levels, not by a "does it exist" read alone:

1. Every step is an upsert keyed on the same tenant-unique index used in §5, so two concurrent
   runs cannot both insert.
2. A duplicate-key error on any step is treated as "already bootstrapped", not as a failure.
3. The whole run is one transaction, so a crash midway leaves no half-created organization.

Re-running prints `already bootstrapped` and exits `0`. There is no `--force`; undoing a bootstrap
is a deliberate database operation, not a CLI flag.

### 4.6 Delivering the first password without logging it

Phase 06 does not hash passwords — argon2 belongs to Phase 07 and pulling it forward would break
the phase boundary. The seeded administrator is therefore created with `passwordHash: undefined`
and `userStatus: 'invited'`; they cannot log in until Phase 07 extends the same command with a
`set-password` step. Open question 1 asks whether that split is acceptable.

When that step lands, these rules apply to it and are stated here so the seed is designed for
them now:

- The password is read from `BOOTSTRAP_ADMIN_PASSWORD` (validated config) or, when absent, from
  an interactive stdin prompt with echo disabled. **Never** from a CLI argument — `argv` is
  visible in `ps` output and shell history.
- It is hashed immediately; the plaintext is never assigned to a logger field, never included in
  the summary line, never written to a file, and is dropped from the config object after use.
- The config loader's "invalid variables" message (Phase 01 §4.1) prints variable names only, so
  a malformed password cannot leak through a startup error.
- `passwordUpdatedAt` is set so Phase 08 can show reset status, and the operator is told to change
  the password after first login.

## 5. Data model changes

All four collections use the Phase 03 base schema: `status: 'A' | 'D'` (required, default `'A'`),
UTC `createdAt` / `updatedAt`, and `createdBy` / `updatedBy` (ObjectId → user; null for
bootstrap/system). Soft-deleted rows (`status: 'D'`) are hidden by default. Domain lifecycle
never overloads row `status`. Every partial index below includes `status: 'A'` so a soft-deleted
row never blocks a new one.

### `organizations`

Opts out of the tenant `orgId` plugin. The document `_id` is the org id other collections store
as `orgId`.

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Display name, 1–200 chars |
| `slug` | `string` | Lowercase `[a-z0-9-]{2,64}`, tenant handle |
| `config` | `object` | Reserved for org settings (retention, limits); `{}` for now |
| `status` | `'A' \| 'D'` | Row visibility |

Indexes: unique `{ slug: 1 }` partial `status: 'A'`; `{ status: 1, _id: -1 }` for keyset lists.

### `users`

| Field | Type | Notes |
|---|---|---|
| `orgId` | `ObjectId` | Tenant key, required |
| `email` | `string` | Stored lowercase and trimmed |
| `displayName` | `string` | 1–120 chars |
| `passwordHash` | `string?` | `select: false`; absent while `invited` |
| `passwordUpdatedAt` | `Date?` | UTC |
| `userStatus` | `'active' \| 'invited' \| 'disabled'` | Domain lifecycle |
| `lastLoginAt` | `Date?` | Written by Phase 07 |
| `status` | `'A' \| 'D'` | Row visibility |

Indexes: unique `{ orgId: 1, email: 1 }` partial `status: 'A'`;
`{ orgId: 1, status: 1, _id: -1 }`; `{ orgId: 1, userStatus: 1, _id: -1 }`.

`passwordHash` is excluded from query results by default so no handler can return it by accident;
Phase 07 must opt in explicitly on the login path.

### `roles`

| Field | Type | Notes |
|---|---|---|
| `orgId` | `ObjectId` | Tenant key |
| `name` | `string` | Display name, unique per active organization |
| `description` | `string?` | Human-readable, shown in Phase 15 |
| `isBuiltIn` | `boolean` | Default `false` |
| `builtInKey` | `string?` | One of the four keys when `isBuiltIn` |
| `permissions` | `string[]` | Empty for built-ins (§4.3) |
| `status` | `'A' \| 'D'` | Row visibility |

Indexes: unique `{ orgId: 1, name: 1 }` partial `status: 'A'`; unique
`{ orgId: 1, builtInKey: 1 }` partial `{ isBuiltIn: true, status: 'A' }`.

### `memberships`

| Field | Type | Notes |
|---|---|---|
| `orgId` | `ObjectId` | Tenant key |
| `userId` | `ObjectId` | Member |
| `roleIds` | `ObjectId[]` | At least one |
| `status` | `'A' \| 'D'` | Row visibility |

Indexes: unique `{ orgId: 1, userId: 1 }` partial `status: 'A'`;
`{ orgId: 1, roleIds: 1 }` for "who has this role" lookups in Phase 11.

## 6. API contract — PROPOSED (needs approval before implementation)

**No HTTP route ships in this phase.** The organization/user/role endpoints in solution §8.4 are
owned by [Phase 11](./phase-11-admin-identity-apis.md), and `POST /organizations` stays a
bootstrap-only path that is never exposed to an unauthenticated caller (decision D6). The
contract below is the command-line surface.

### `npm run bootstrap`

- **Auth:** operating-system access to the server and the configured `MONGODB_URI`. No token.
- **Success output (stdout, once, no credentials):**

```json
{
  "result": "created",
  "orgId": "6710c0a1f2b34c5d6e7f8091",
  "slug": "acme",
  "adminUserId": "6710c0a1f2b34c5d6e7f8092",
  "adminUserStatus": "invited",
  "builtInRoles": ["org_admin", "project_admin", "member", "viewer"]
}
```

- **Second run:** identical body with `"result": "already_bootstrapped"`, exit code `0`.
- **Failure:** exit code `1` plus one line using the platform envelope from
  `backend/src/platform/errors.js`, so the seed and the API speak the same language:

```json
{ "error": { "code": "BOOTSTRAP_CONFIG_INVALID", "message": "Bootstrap variables are missing or invalid.", "details": { "variables": ["BOOTSTRAP_ADMIN_EMAIL"] } }}
```

New codes registered in the Phase 02 catalog: `BOOTSTRAP_CONFIG_INVALID` (user, 400-class,
`user_action_required`) and `BOOTSTRAP_FAILED` (system, 500-class, `permanent`). `details` lists
variable **names** only — never values.

## 7. Configuration & environment variables

Add to `backend/.env.example` **and** mirror the same keys into `backend/.env`
(`.cursor/rules/env-example-sync.mdc`). These are per-install identity values, not tunables
(`.cursor/rules/env-config.mdc`). Never print `.env` contents in chat, logs, or a test
snapshot.

| Variable | Example | Required | Purpose |
|---|---|---|---|
| `BOOTSTRAP_ORG_NAME` | `Acme Corporation` | only for the seed | Display name of the first organization |
| `BOOTSTRAP_ORG_SLUG` | `acme` | only for the seed | Tenant handle, lowercase |
| `BOOTSTRAP_ADMIN_EMAIL` | `admin@acme.test` | only for the seed | First administrator's email |
| `BOOTSTRAP_ADMIN_NAME` | `Acme Administrator` | no (defaults to the email local part) | Display name |

`BOOTSTRAP_ADMIN_PASSWORD` is **not** added here — it belongs to the Phase 07 step that can hash
it. These four are optional for the API and worker processes and are only required when the
bootstrap command runs, so the Phase 01 loader must not fail a normal startup when they are
absent.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/identity/organization.model.js` | **New:** Organization schema + indexes |
| `backend/src/modules/identity/user.model.js` | **New:** User schema, `userStatus`, hidden `passwordHash` |
| `backend/src/modules/identity/role.model.js` | **New:** Role schema, built-in guard |
| `backend/src/modules/identity/membership.model.js` | **New:** Membership schema |
| `backend/src/modules/identity/builtInRoles.js` | **New:** The four built-in role keys and descriptions |
| `backend/src/modules/identity/organization.repository.js` | **New:** Slug lookup, create, soft delete |
| `backend/src/modules/identity/user.repository.js` | **New:** Org-scoped find/create/list/soft delete |
| `backend/src/modules/identity/role.repository.js` | **New:** Org-scoped role reads and built-in seeding |
| `backend/src/modules/identity/membership.repository.js` | **New:** Org-scoped membership reads and writes |
| `backend/src/modules/identity/index.js` | **New:** Public surface of the module |
| `backend/src/modules/identity/*.test.js` | **New:** Colocated tests for every file above |
| `backend/src/cli/bootstrap.js` | **New:** Idempotent transactional seed command |
| `backend/src/cli/bootstrap.test.js` | **New:** First run, second run, concurrent run, failure |
| `backend/src/platform/errorCatalog.js` | Register `BOOTSTRAP_CONFIG_INVALID`, `BOOTSTRAP_FAILED` |
| `backend/src/platform/config.js` | Add the optional `bootstrap` config group |
| `backend/package.json` | Add the `bootstrap` script |
| `backend/.env.example` / `backend/.env` | Document and mirror the four variables |

## 9. Tests (≥ 80% line and branch)

### Unit (schema and repository behaviour)

- `it('defaults status to A on insert')` for all four models.
- `it('rejects a userStatus outside active|invited|disabled')`.
- `it('rejects a role whose builtInKey is not one of the four keys')`.
- `it('lowercases and trims email before saving')`.
- `it('omits passwordHash from a default query result')`.
- `it('rejects a rename of a built-in role')` and the same for a permission edit.
- `it('rejects a soft delete of a built-in role')`.
- `it('throws when a repository call is made without an orgId')`.

### Integration (real Mongo via the Phase 03 harness)

- `it('allows the same email in two different organizations')`.
- `it('rejects a duplicate active email inside one organization')`.
- `it('allows re-creating a user whose previous row is status D')` — the partial index works.
- `it('excludes status D users from listUsers')` and the same for roles and memberships.
- `it('returns a keyset page ordered by _id descending')` for the user list.
- `it('finds a membership only within its own organization')` — a cross-tenant read by a valid
  `userId` with the wrong `orgId` returns null, not the document.
- `it('creates organization, four roles, admin user and membership on first bootstrap')`.
- `it('changes nothing and exits 0 on a second bootstrap')` — asserts unchanged `updatedAt`.
- `it('creates exactly one organization when two bootstraps run concurrently')`.
- `it('leaves no organization behind when the membership insert fails')` — transaction rollback.

### Unhappy paths that must be covered

- Bootstrap with a missing `BOOTSTRAP_ADMIN_EMAIL` → exit `1`, `BOOTSTRAP_CONFIG_INVALID`, and
  the message names the variable without printing any value.
- Bootstrap with an invalid slug (`Acme Corp!`) → rejected before any write.
- Bootstrap against an unreachable Mongo → `BOOTSTRAP_FAILED`, exit `1`, no partial writes.
- No test and no code path logs `BOOTSTRAP_ADMIN_*` values — assert the captured log output.

## 10. Definition of Done

- [ ] Four models exist, each with `status: 'A' | 'D'` defaulting to `'A'`, UTC timestamps, and
      `createdBy` / `updatedBy`.
- [ ] `userStatus` exists as a separate field and no code path uses `status` for enable/disable.
- [ ] Every tenant-unique index is partial on `status: 'A'` and verified by an integration test.
- [ ] Every tenant-scoped repository function requires an `orgId`; `organizations` opts out of
      the tenant plugin.
- [ ] The four built-in roles are seeded per organization and cannot be renamed, re-permissioned,
      or soft-deleted through a repository call.
- [ ] `npm run bootstrap` creates the first organization and admin; a second run is a no-op that
      exits `0`.
- [ ] No route, script, or test can create an organization from an unauthenticated HTTP request.
- [ ] `BOOTSTRAP_*` variables are in `backend/.env.example` and mirrored into `backend/.env`.
- [ ] No credential, password, or `.env` value appears in any log line, stdout summary, or test
      fixture.
- [ ] `npm run lint`, and `npm test` pass; coverage ≥ 80% line and branch for
      every file this phase touched.

## 11. Documentation & ADR updates

- Create `docs/data-model.md` (or extend it if Phase 03 already created it) with the four
  collections, their indexes, and the `status` versus `userStatus` rule.
- `docs/architecture.md` §3 already lists "Orgs, users, roles, memberships" under MongoDB —
  confirm the field names match and adjust wording only if they differ.
- Record an ADR in `docs/adr/` for **bootstrap-only tenant creation**: context (D6, no public
  signup), decision (CLI seed, no HTTP path), consequences (operator access is required to
  onboard a tenant), alternatives (invite-only signup endpoint, platform-admin API).
- Add a short "First run" section to `backend/README` or the root README describing
  `npm run bootstrap` — referencing variable names only.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Seeded admin without a password.** The proposal leaves the first administrator
   `userStatus: 'invited'` with no `passwordHash` until [Phase 07](./phase-07-authentication.md)
   adds hashing. Is that acceptable, or should the argon2 hasher be pulled into this phase so the
   bootstrap produces a usable login in one step?
2. **Second and subsequent organizations.** The bootstrap command creates one tenant. How is
   tenant number two onboarded — re-running the command with different variables, or a
   platform-administrator API that this plan has not scoped anywhere?
3. **Role assignment cardinality.** `Membership.roleIds` is an array. Should a user be allowed to
   hold several roles at once (union of permissions), or exactly one role, which would simplify
   [Phase 09](./phase-09-rbac-engine.md) and the Phase 15 admin UI?
4. **Built-in role permissions at read time.** Resolving built-ins from code (§4.3) means the
   admin UI cannot edit them and a code change silently changes every tenant's effective access.
   Is that the intent, or should built-ins be materialized per organization at seed time and
   migrated explicitly?
5. **Organization `config`.** Which settings belong there in this phase (retention defaults, rate
   limits, password policy), and which stay in environment configuration until the phase that
   needs them?
6. **Email uniqueness scope.** Uniqueness is per organization, so the same person can exist as
   two users in two tenants with separate passwords. Confirm that is intended rather than a single
   global identity.
