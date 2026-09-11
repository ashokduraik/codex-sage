# Phase 03 — Data-layer conventions, base schema & test harness

- **Layer:** BE
- **Depends on:** Phase 01 (Mongoose connection, validated config)
- **Unblocks:** Phase 06 and every later collection, repository, and integration test
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §89 (data isolation), §101 (retention /
  deletion posture); `backend/solution.md` §6 (Mongoose usage); `docs/architecture.md` §3;
  `.cursor/rules/row-status.mdc`, `soft-delete.mdc`, `data-model.mdc`; plan decisions D5, D13,
  D16

## 1. Goal

After this phase every Mongoose model is built on one **base schema** (row `status: 'A' | 'D'`,
UTC timestamps), list and detail queries default to active rows, tenant collections require
`organizationId`, schema changes ship as **versioned migrations** under `backend/migrations/`,
and integration tests talk to the **same external MongoDB 8 replica set** using database name
`codex_sage_test` (**D16**). Production never relies on `autoIndex`.

You can see it working by running a fixture model test: inserting a row, soft-deleting it
(`status: 'D'`), and watching the default finder return nothing; and by running the harness
twice against the replica set without touching the development database named in `MONGODB_URI`.

## 2. Why this phase is here

Phase 06 cannot invent row-status, timestamps, tenant keys, or a test database of its own —
every later module would copy a slightly different convention. Phase 01 already connects
Mongoose; this phase owns *how* documents are shaped and *how* tests isolate data. It does
not block Phase 02 (errors) or Phase 04 (ADRs); those can run in parallel.

It cannot come later: the first domain collection (organizations) must inherit the base
schema on day one, and the first integration test must not write into the development
database.

## 3. Scope

### In scope

- Shared Mongoose plugins: row `status`, UTC `createdAt` / `updatedAt`, optional tenant key.
- Query defaults that exclude `status: 'D'` unless the caller opts in.
- Repository conventions: every tenant read/write takes `organizationId`; helpers never
  accept a client-supplied scope as authority.
- Versioned migration runner and folder `backend/migrations/`.
- Integration-test harness that rewrites the database name in `MONGODB_URI` to
  `codex_sage_test`. **No `mongodb-memory-server`.**
- `autoIndex: false` in production; development may still use `autoIndex` for local
  convenience, but indexes that matter ship as migrations.

### Out of scope (owner phase)

- Any domain collection — **Phase 06 onward**.
- GridFS bucket helpers — **Phase 24**.
- Job claim indexes — **Phase 20 / 21**.
- Error catalog codes beyond those Phase 02 already owns (`TENANT_SCOPE_MISSING`,
  `INVALID_CURSOR` are consumed here, not invented).

## 4. Design

### 4.1 Base schema plugin

One plugin applied by every domain model:

```text
status     : 'A' | 'D'   required, default 'A', enum only those two
createdAt  : Date        UTC, set on insert
updatedAt  : Date        UTC, set on insert and every update
```

Domain lifecycle (`userStatus`, `lifecycleStatus`, `jobStatus`, `knowledgeHealth`,
`connectionStatus`) is **never** this field. Timestamps are stored as BSON Date and
serialized as ISO-8601 with a `Z` suffix. Application code does not call `new Date()` for
persistence when the operation can use Mongo server time (`$$NOW`) — lease and claim paths
in Phase 21 will need that; the helper is introduced here.

### 4.2 Soft-delete query defaults

Mongoose query middleware on `find`, `findOne`, `countDocuments`, `findOneAndUpdate` (and
aggregations that list documents) adds `{ status: 'A' }` unless the query explicitly sets
`status` or the caller uses `includeDeleted()`. Soft delete is:

```text
updateOne({ _id, organizationId, status: 'A' }, { $set: { status: 'D' } })
```

Never `deleteOne` / `deleteMany` on user-facing resources. Hard purge is out of this plan
(README §5 / a later ADR). Background jobs must use the same default so a detached project
is not processed.

### 4.3 Tenant `organizationId`

Tenant collections declare `organizationId` as required `ObjectId`. A second plugin
rejects `save` / `insert` without it and rejects repository methods that omit it
(`TENANT_SCOPE_MISSING`). Platform collections that are not tenant-scoped (none in this
phase; later: possibly migration metadata) opt out explicitly. List repositories never
take `organizationId` from the request body; the authenticated context (Phase 07) will
supply it. Until then, tests pass it as a function argument.

### 4.4 Versioned migrations

Folder `backend/migrations/`. Each file is `NNNN-short-name.js` exporting:

```text
id: string            // matches the filename prefix
description: string
up(session): Promise<void>
```

A `schemaMigrations` collection records applied `id`s (`status: 'A' | 'D'` still required
on that collection). `npm run migrate` in `backend/` applies pending files in order, each
inside a transaction when the operation is transactional (D5). Startup in development may
call the same runner; **production startup does not silently migrate** — operators run
`migrate` deliberately. Migrations create collections and indexes; they do not rely on
`autoIndex`.

There is no `down` in this slice. Rollback is a forward migration or a restored backup.

### 4.5 Integration-test harness (**D16**)

`backend/src/test/mongoHarness.js`:

1. Read `MONGODB_URI` from the same validated config as the app.
2. Parse the URI and **substitute the database name** with constant `TEST_DATABASE_NAME`
   (`codex_sage_test`). No new env var.
3. Connect with the same mongoose options as production (pool constants from Phase 01).
4. `beforeAll`: connect once per Vitest worker.
5. `afterEach`: delete documents from collections used in that file (or drop those
   collections), never the development database.
6. `afterAll`: disconnect.

`mongodb-memory-server` is not a dependency and is not added. Tests that need transactions
use the replica set already required by D5. The harness refuses to run if the resolved
database name is not `codex_sage_test`, so a mis-parsed URI cannot wipe development data.

### 4.6 Cursor pagination helper

A small encoder/decoder for keyset cursors (`createdAt` + `_id`, opaque URL-safe string).
Invalid cursors throw `INVALID_CURSOR`. Phase 11 and 17 reuse this; do not invent a second
format later.

## 5. Data model changes

No product collection. One platform collection:

### `schemaMigrations`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Migration id, unique |
| `appliedAt` | Date | UTC |
| `status` | `'A' \| 'D'` | default `'A'` |

Index: unique `{ id: 1 }` partial `status: 'A'`.

## 6. API contract — PROPOSED (needs approval before implementation)

**No HTTP endpoint.** Internal contracts:

- `createBaseSchema(definition)` → schema with plugins applied.
- `includeDeleted(query)` → query that may see `status: 'D'`.
- `softDelete(filter)` → sets `status: 'D'` only on `status: 'A'` matches.
- `encodeCursor` / `decodeCursor`.
- `applyPendingMigrations()`.
- `withMongoHarness()` for tests.

## 7. Configuration & environment variables

**None.** No new `.env` keys. `MONGODB_URI` stays the Phase 01 variable. The test database
name is a constant.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `TEST_DATABASE_NAME` | `'codex_sage_test'` | `src/test/mongoHarness.js` | Database name substituted into `MONGODB_URI` for tests |
| `ROW_STATUS_ACTIVE` | `'A'` | `src/platform/data/rowStatus.js` | Active row |
| `ROW_STATUS_DELETED` | `'D'` | `src/platform/data/rowStatus.js` | Soft-deleted row |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/platform/data/rowStatus.js` | **New:** `'A' \| 'D'` constants |
| `backend/src/platform/data/baseSchema.js` | **New:** plugins + `createBaseSchema` |
| `backend/src/platform/data/baseSchema.test.js` | **New:** defaults, soft-delete, timestamps |
| `backend/src/platform/data/cursors.js` | **New:** keyset encode/decode |
| `backend/src/platform/data/cursors.test.js` | **New:** round-trip, invalid cursor |
| `backend/src/platform/data/migrations.js` | **New:** runner |
| `backend/src/platform/data/migrations.test.js` | **New:** apply once, skip applied, order |
| `backend/migrations/.gitkeep` | **New:** folder exists |
| `backend/src/test/mongoHarness.js` | **New:** URI rewrite + connect/cleanup |
| `backend/src/test/mongoHarness.test.js` | **New:** refuses non-test db name; rewrites path |
| `backend/package.json` | **Change:** `migrate` script |
| `backend/src/platform/mongo.js` | **Change:** `autoIndex` off in production |

## 9. Tests (≥ 80% line and branch)

### Unit

- Base schema default `status: 'A'`; rejecting any other value.
- Soft-delete hides the row from default `find`; `includeDeleted` still sees it.
- `updatedAt` changes on update; stored value is UTC.
- Insert without `organizationId` on a tenant schema throws `TENANT_SCOPE_MISSING`.
- Cursor round-trip; malformed cursor → `INVALID_CURSOR`.
- Migration runner applies `0001` then `0002` and is a no-op on a second run.

### Integration (harness)

- Connecting through the harness uses database `codex_sage_test`.
- A document written in a test is gone after `afterEach`.
- The development database named in the original URI has no new collections from the suite.
- A URI whose rewritten name would not be `codex_sage_test` is rejected.

### Unhappy paths

- Two concurrent `migrate` runs apply each file once (unique index / transaction).
- `softDelete` on an already-`'D'` row matches zero documents.

## 10. Definition of Done

- [ ] Every new model in later phases can be built with `createBaseSchema`; there is one
      definition of row `status`.
- [ ] Default queries never return `status: 'D'`.
- [ ] Tenant schemas require `organizationId`.
- [ ] `backend/migrations/` exists and `npm run migrate` applies pending files.
- [ ] Production mongoose sets `autoIndex: false`.
- [ ] Integration tests use `codex_sage_test` on the external replica set; no
      `mongodb-memory-server` dependency.
- [ ] The harness refuses to run against any other database name.
- [ ] No new `.env` keys.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- Create `docs/data-model.md` with the row-status rule, UTC timestamps, tenant-key rule, and
  the `schemaMigrations` collection.
- `docs/architecture.md` §3: one line that schema changes go through `backend/migrations/`.
- No new ADR expected; MongoDB as datastore is Phase 04.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Migrate on boot in development?** Proposed: yes, so `npm run dev` is enough. Production
   stays explicit `npm run migrate`. Confirm.
2. **Test cleanup:** `deleteMany` per collection vs `dropDatabase` on `codex_sage_test` after
   the suite. Drop is faster and complete; delete is safer if two suites share the name.
   Proposal: drop the test database in `afterAll` of the global setup, plus `deleteMany` in
   `afterEach` for isolation inside a file.
3. **Global mongoose plugins vs per-schema.** Proposed: per-schema via `createBaseSchema` so
   a platform collection can opt out. Confirm.
4. **Cursor payload.** Proposed: `{ t: iso, i: hexObjectId }` then base64url. Confirm before
   Phase 11 freezes the header/query format.
