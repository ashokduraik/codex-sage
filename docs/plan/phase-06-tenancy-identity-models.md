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

On every API process startup (after Mongo connects, before listen), an idempotent seed runs:
it checks for the default organization, the four built-in roles, the first administrator, and
the admin membership; any missing row is created from **named constants in code** (no
`BOOTSTRAP_*` env vars). A second startup changes nothing. There is still no HTTP route and no
login — Phase 07 adds those. There is **no** `npm run bootstrap` CLI.

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
- An automatic, idempotent, transactional startup seed in the API process — check-then-create
  missing rows from named constants; clean structured logs (`info` one summary, `debug` per step).
- Confirm `LOG_LEVEL` remains documented in `backend/.env.example` (already present from Phase 01);
  no new bootstrap env keys.

### Out of scope (owner phase)

- Password hashing, login, tokens, sessions — **Phase 07**.
- Password reset and temporary credentials — **Phase 08**.
- The permission catalog, permission resolution, route guards — **Phase 09**.
- Audit events for identity changes — **Phase 10**.
- Admin user/role/membership HTTP APIs — **Phase 11**.
- `ProjectMember` (the project ACL overlay) — **Phase 18**.
- A standalone CLI bootstrap command — **not in this product path**; startup seed replaces it.
- Worker-process seeding — API startup only.

## 4. Design

### 4.1 Module layout

One module, `src/modules/identity/`, following the repo's `model + repository + tests` shape with
a single public surface (`index.js`). Nothing outside the module imports a model file directly;
later phases consume the repositories. Routes arrive in Phase 11 and live in the same module.
The seed lives in the same module (e.g. `bootstrapSeed.js`) and is invoked from the API entry
(`src/index.js`) after `connectMongo` and before `listen`.

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

### 4.5 Bootstrap seed (automatic on API startup)

Runs inside the API boot sequence only — not on the worker, not as a CLI, not as an HTTP route.
There is no public signup (D6), and no HTTP surface may ever create an organization from an
unauthenticated request.

**Default identity values** are **named constants** next to the seed module (not env, not
`AppConfig` — `.cursor/rules/env-config.mdc`). Locked defaults:

| Constant | Value | Purpose |
|---|---|---|
| `DEFAULT_ORG_NAME` | `Default Organization` | Display name of the first organization |
| `DEFAULT_ORG_SLUG` | `default` | Tenant handle, lowercase `[a-z0-9-]{2,64}` |
| `DEFAULT_ADMIN_EMAIL` | `admin@localhost` | First administrator's email |
| `DEFAULT_ADMIN_NAME` | `Administrator` | Display name |

`result` is `created` if any row was inserted this run, else `already_present`. A second run
does **not** repair membership `roleIds` or update existing timestamps.

```text
API start → connectMongo → runBootstrapSeed(log) → buildApp → listen

1. start session + transaction
2. find organization by DEFAULT_ORG_SLUG (status A)
   → missing: create; present: reuse
3. for each built-in role key: find by (orgId, builtInKey)
   → missing: create; present: reuse
4. find admin user by (orgId, DEFAULT_ADMIN_EMAIL)
   → missing: create with userStatus 'invited', no passwordHash
   → present: reuse
5. find membership by (orgId, adminUserId)
   → missing: create with org_admin roleId
   → present: reuse (ensure org_admin is among roleIds if seed owns that invariant)
6. commit
7. always log one clear info success line (created | already_present)
```

**Idempotency** is enforced at three levels, not by a "does it exist" read alone:

1. Every create step is an upsert keyed on the same tenant-unique index used in §5, so two
   concurrent API processes cannot both insert conflicting rows.
2. A duplicate-key error on any step is treated as "already present", not as a failure.
3. The whole run is one transaction, so a crash midway leaves no half-created organization.

There is no `--force` and no env override; undoing a bootstrap is a deliberate database
operation. Changing default identity later is a code change to the named constants (or a later
admin API), not an env flip.

### 4.6 Logging (clean, level-aware)

Seed logging uses the same structured logger / `LOG_LEVEL` as the rest of the API
(Phase 01 / ADR 0005). Rules:

| Level | What the seed emits |
|---|---|
| `info` | **Exactly one** success line every startup after the seed finishes, always — whether rows were created or already present. Message is clear and operator-readable (e.g. `bootstrap seed succeeded`). Fields: `result` (`created` \| `already_present`), `orgId`, `slug`, `adminUserId`, `adminUserStatus`, `builtInRoles` (keys only). **No** email, display name, password, or env values. |
| `debug` | Optional **per-step** lines (org check/create, each role, user, membership) for local diagnosis. Still no credentials or PII beyond ids/slug already in the info summary. |
| `warning` / `error` | Only on real problems; seed failure uses `BOOTSTRAP_FAILED` and fails the API process (exit non-zero) so the service does not listen half-bootstrapped. |

At `LOG_LEVEL=info` (default in `.env.example`) the console stays clean: one seed success line
plus normal boot lines (mongo connected, listening). At `LOG_LEVEL=debug` the same success
line appears, plus the step-by-step seed trail.

### 4.7 Delivering the first password without logging it

Phase 06 does not hash passwords — argon2 belongs to Phase 07 and pulling it forward would break
the phase boundary. The seeded administrator is therefore created with `passwordHash: undefined`
and `userStatus: 'invited'`; they cannot log in until Phase 07 extends the startup seed (or a
Phase 07-owned path) with a set-password step. Open question 1 asks whether that split is
acceptable.

When that step lands, these rules apply to it and are stated here so the seed is designed for
them now:

- Phase 07 decides how the first password is supplied (this phase adds **no**
  `BOOTSTRAP_ADMIN_PASSWORD` env key). **Never** from a CLI argument — `argv` is visible in
  `ps` output and shell history.
- It is hashed immediately; the plaintext is never assigned to a logger field, never included in
  the info success line, never written to a file, and is dropped from memory after use.
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

**No HTTP route and no CLI ships in this phase.** The organization/user/role endpoints in
solution §8.4 are owned by [Phase 11](./phase-11-admin-identity-apis.md), and
`POST /organizations` stays a bootstrap/system path that is never exposed to an
unauthenticated caller (decision D6). The contract below is the **startup seed** surface.

### Startup seed (`runBootstrapSeed`)

- **Auth:** none — runs inside the API process after a successful Mongo connect.
- **Trigger:** every API boot; worker does not run it.
- **Success (always, one `info` log, no credentials / no email):**

```json
{
  "msg": "bootstrap seed succeeded",
  "result": "created",
  "orgId": "6710c0a1f2b34c5d6e7f8091",
  "slug": "default",
  "adminUserId": "6710c0a1f2b34c5d6e7f8092",
  "adminUserStatus": "invited",
  "builtInRoles": ["org_admin", "project_admin", "member", "viewer"]
}
```

- **When rows already exist:** same shape with `"result": "already_present"`; process continues
  to listen (exit remains normal).
- **Failure:** process exits `1` before listen; one error log using the platform envelope from
  `backend/src/platform/errors.js`:

```json
{ "error": { "code": "BOOTSTRAP_FAILED", "message": "Bootstrap seed failed.", "details": {} } }
```

New code registered in the Phase 02 catalog: `BOOTSTRAP_FAILED` (system, 500-class,
`permanent`). There is **no** `BOOTSTRAP_CONFIG_INVALID` — identity defaults are constants, not
env. Log fields never include emails, passwords, or `.env` values.

## 7. Configuration & environment variables

**No `BOOTSTRAP_*` variables.** Seed identity is named constants in the identity module
(`.cursor/rules/env-config.mdc`). Do not add them to `backend/.env.example` or `backend/.env`.

Logging already has a level option (Phase 01) — keep it documented; no change required beyond
confirming the seed respects it:

| Variable | Example | Required | Purpose |
|---|---|---|---|
| `LOG_LEVEL` | `info` | no (default `info`) | `debug` \| `info` \| `warning` \| `error` — controls seed verbosity (`info` = one success line; `debug` = success + per-step) |

`BOOTSTRAP_ADMIN_PASSWORD` is **not** added here — password delivery belongs to Phase 07 and
must not reintroduce bootstrap identity env keys unless a later ADR explicitly overrides this
decision.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/identity/organization.model.js` | **New:** Organization schema + indexes |
| `backend/src/modules/identity/user.model.js` | **New:** User schema, `userStatus`, hidden `passwordHash` |
| `backend/src/modules/identity/role.model.js` | **New:** Role schema, built-in guard |
| `backend/src/modules/identity/membership.model.js` | **New:** Membership schema |
| `backend/src/modules/identity/builtInRoles.js` | **New:** The four built-in role keys and descriptions |
| `backend/src/modules/identity/bootstrapDefaults.js` | **New:** Named constants for default org/admin identity |
| `backend/src/modules/identity/organization.repository.js` | **New:** Slug lookup, create, soft delete |
| `backend/src/modules/identity/user.repository.js` | **New:** Org-scoped find/create/list/soft delete |
| `backend/src/modules/identity/role.repository.js` | **New:** Org-scoped role reads and built-in seeding |
| `backend/src/modules/identity/membership.repository.js` | **New:** Org-scoped membership reads and writes |
| `backend/src/modules/identity/bootstrapSeed.js` | **New:** Idempotent transactional check-then-create seed |
| `backend/src/modules/identity/index.js` | **New:** Public surface of the module (incl. seed export) |
| `backend/src/modules/identity/*.test.js` | **New:** Colocated tests for every file above |
| `backend/src/index.js` | Call `runBootstrapSeed` after `connectMongo`, before `listen` |
| `backend/src/platform/errorCatalog.js` | Register `BOOTSTRAP_FAILED` |
| `backend/.env.example` | Confirm `LOG_LEVEL` is documented; **do not** add `BOOTSTRAP_*` |

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
- `it('emits exactly one info success log and no debug logs when log level is info')`.
- `it('emits per-step debug logs when log level is debug')`.

### Integration (real Mongo via the Phase 03 harness)

- `it('allows the same email in two different organizations')`.
- `it('rejects a duplicate active email inside one organization')`.
- `it('allows re-creating a user whose previous row is status D')` — the partial index works.
- `it('excludes status D users from listUsers')` and the same for roles and memberships.
- `it('returns a keyset page ordered by _id descending')` for the user list.
- `it('finds a membership only within its own organization')` — a cross-tenant read by a valid
  `userId` with the wrong `orgId` returns null, not the document.
- `it('creates organization, four roles, admin user and membership on first seed')`.
- `it('changes nothing on a second seed and reports already_present')` — asserts unchanged
  `updatedAt`.
- `it('creates exactly one organization when two seeds run concurrently')`.
- `it('leaves no organization behind when the membership insert fails')` — transaction rollback.

### Unhappy paths that must be covered

- Seed with a broken / unreachable Mongo connection mid-transaction → `BOOTSTRAP_FAILED`,
  API boot aborts before listen, no partial writes.
- Captured logs never include `DEFAULT_ADMIN_EMAIL`, passwords, or `.env` values — assert
  against the info (and debug) output.

## 10. Definition of Done

- [ ] Four models exist, each with `status: 'A' | 'D'` defaulting to `'A'`, UTC timestamps, and
      `createdBy` / `updatedBy`.
- [ ] `userStatus` exists as a separate field and no code path uses `status` for enable/disable.
- [ ] Every tenant-unique index is partial on `status: 'A'` and verified by an integration test.
- [ ] Every tenant-scoped repository function requires an `orgId`; `organizations` opts out of
      the tenant plugin.
- [ ] The four built-in roles are seeded per organization and cannot be renamed, re-permissioned,
      or soft-deleted through a repository call.
- [ ] API startup runs the seed automatically; a second startup is a no-op that still logs one
      clear `info` success with `result: already_present`.
- [ ] No CLI bootstrap script; no `BOOTSTRAP_*` env keys.
- [ ] At `LOG_LEVEL=info`, seed emits one success line; at `debug`, that line plus per-step
      detail. `LOG_LEVEL` remains documented in `backend/.env.example`.
- [ ] No route or test can create an organization from an unauthenticated HTTP request.
- [ ] No credential, password, email, or `.env` value appears in any seed log line or test
      fixture assertion of logs.
- [ ] `npm run lint`, and `npm test` pass; coverage ≥ 80% line and branch for
      every file this phase touched.

## 11. Documentation & ADR updates

- Create `docs/data-model.md` (or extend it if Phase 03 already created it) with the four
  collections, their indexes, and the `status` versus `userStatus` rule.
- `docs/architecture.md` §3 already lists "Orgs, users, roles, memberships" under MongoDB —
  confirm the field names match and adjust wording only if they differ.
- Record an ADR in `docs/adr/` for **startup bootstrap seed (no public signup)**: context (D6),
  decision (API startup check-then-create from named constants; no CLI; no `BOOTSTRAP_*` env;
  no unauthenticated HTTP create), consequences (first tenant appears automatically; changing
  defaults is a code change; multi-tenant onboarding still needs a later path), alternatives
  (CLI seed with env vars, invite-only signup endpoint, platform-admin API).
- Add a short "First run" section to `backend/README` or the root README: start the API; seed
  runs automatically; point at `LOG_LEVEL` for verbosity — no bootstrap env variable names.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Seeded admin without a password.** The proposal leaves the first administrator
   `userStatus: 'invited'` with no `passwordHash` until [Phase 07](./phase-07-authentication.md)
   adds hashing. Is that acceptable, or should the argon2 hasher be pulled into this phase so the
   bootstrap produces a usable login in one step?
2. **Default constant values.** Proposed: org `Default Organization` / slug `default`, admin
   `admin@localhost` / `Administrator`. Confirm or supply the exact strings to hardcode.
3. **Second and subsequent organizations.** The startup seed creates one tenant from constants.
   How is tenant number two onboarded — a platform-administrator API that this plan has not
   scoped anywhere?
4. **Role assignment cardinality.** `Membership.roleIds` is an array. Should a user be allowed to
   hold several roles at once (union of permissions), or exactly one role, which would simplify
   [Phase 09](./phase-09-rbac-engine.md) and the Phase 15 admin UI?
5. **Built-in role permissions at read time.** Resolving built-ins from code (§4.3) means the
   admin UI cannot edit them and a code change silently changes every tenant's effective access.
   Is that the intent, or should built-ins be materialized per organization at seed time and
   migrated explicitly?
6. **Organization `config`.** Which settings belong there in this phase (retention defaults, rate
   limits, password policy), and which stay in environment configuration until the phase that
   needs them?
7. **Email uniqueness scope.** Uniqueness is per organization, so the same person can exist as
   two users in two tenants with separate passwords. Confirm that is intended rather than a single
   global identity.
