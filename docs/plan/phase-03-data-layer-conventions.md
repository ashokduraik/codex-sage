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
UTC timestamps, actor fields `createdBy` / `updatedBy`), list and detail queries default to
active rows, tenant collections require `orgId`, indexes are **declared on schemas** (not a
versioned migration runner), and integration tests talk to the **same external MongoDB 8
replica set** using database name `codex_sage_test` (**D16**). Production never relies on
`autoIndex`.

**No versioned schema migrations in this stage.** The datastore is MongoDB and the product is
pre–go-live; collections and indexes evolve with schema definitions. A migration runner can be
introduced later when production cutover needs controlled, repeatable schema changes.

You can see it working by running a fixture model test: inserting a row, soft-deleting it
(`status: 'D'`), and watching the default finder return nothing; and by running the harness
twice against the replica set without touching the development database named in `MONGODB_URI`.

## 2. Why this phase is here

Phase 06 cannot invent row-status, timestamps, actor fields, tenant keys, indexes, or a test
database of its own — every later module would copy a slightly different convention. Phase 01
already connects Mongoose; this phase owns *how* documents are shaped, *how* indexes are
declared, and *how* tests isolate data. It does not block Phase 02 (errors) or Phase 04
(ADRs); those can run in parallel.

It cannot come later: the first domain collection (organizations) must inherit the base
schema on day one, and the first integration test must not write into the development
database.

## 3. Scope

### In scope

- Shared Mongoose plugins: row `status`, UTC `createdAt` / `updatedAt`, `createdBy` /
  `updatedBy` (ObjectId → user), optional tenant key `orgId`.
- Query defaults that exclude `status: 'D'` unless the caller opts in.
- Repository conventions: every tenant read/write takes `orgId`; helpers never accept a
  client-supplied scope as authority.
- Index conventions: every schema declares the indexes it needs; production uses
  `autoIndex: false`. **Development startup and the test harness call
  `syncSchemaIndexes`.**
- Integration-test harness that rewrites the database name in `MONGODB_URI` to
  `codex_sage_test`. **No `mongodb-memory-server`.**

### Out of scope (owner phase)

- Versioned migration runner / `backend/migrations/` — **deferred until go-live** (or a later
  phase that introduces production cutover).
- Any domain collection — **Phase 06 onward**.
- GridFS bucket helpers — **Phase 24**.
- Job claim indexes — **Phase 20 / 21** (declared on those schemas when built).
- Error catalog codes beyond those Phase 02 already owns (`TENANT_SCOPE_MISSING`,
  `INVALID_CURSOR` are consumed here, not invented).

## 4. Design

### 4.1 Base schema plugin

One plugin applied by every domain model:

```text
status     : 'A' | 'D'   required, default 'A', enum only those two
createdAt  : Date        UTC, set on insert
updatedAt  : Date        UTC, set on insert and every update
createdBy  : ObjectId    ref users (userId); set on insert; null allowed for system/bootstrap
updatedBy  : ObjectId    ref users (userId); set on insert and every update; null allowed for
                         system/bootstrap
```

Domain lifecycle (`userStatus`, `lifecycleStatus`, `jobStatus`, `knowledgeHealth`,
`connectionStatus`) is **never** the row `status` field. Timestamps are stored as BSON Date and
serialized as ISO-8601 with a `Z` suffix. Application code does not call `new Date()` for
persistence when the operation can use Mongo server time (`$$NOW`) — lease and claim paths
in Phase 21 will need that; the helper is introduced here.

Repositories stamp `createdBy` on insert and `updatedBy` on every update from the caller's
`userId` when present (null for system/bootstrap). Soft delete also sets `updatedBy` (and
`updatedAt`). Until Phase 07 auth exists, tests pass actors as function arguments. Phase 02's
request-context ALS will expose `{ correlationId, orgId?, userId? }` once auth lands.

### 4.2 Soft-delete query defaults

Mongoose query middleware on `find`, `findOne`, `countDocuments`, `findOneAndUpdate` (and
aggregations that list documents) adds `{ status: 'A' }` unless the query explicitly sets
`status` or the caller uses `includeDeleted()`. Soft delete is:

```text
updateOne(
  { _id, orgId, status: 'A' },
  { $set: { status: 'D', updatedBy, updatedAt } }
)
```

Never `deleteOne` / `deleteMany` on user-facing resources. Hard purge is out of this plan
(README §5 / a later ADR). Background jobs must use the same default so a detached project
is not processed.

### 4.3 Tenant `orgId`

Tenant collections declare `orgId` as required `ObjectId`. A second plugin rejects `save` /
`insert` without it and rejects repository methods that omit it (`TENANT_SCOPE_MISSING`).
**`organizations` opts out** of the tenant plugin (the org document's `_id` *is* the org id).
Other platform collections that are not tenant-scoped also opt out explicitly.

`orgId` is the single name everywhere: Mongo fields, repository args, request context /
`principal`, and API JSON. The JWT claim key stays the short `org` and carries that same id;
`principal.orgId` is set from it. List repositories never take `orgId` from the request body;
the authenticated context (Phase 07) supplies it. Until then, tests pass it as a function
argument.

### 4.4 Indexes (schema-declared; no migration runner yet)

Indexes live next to the schema that needs them (`schema.index(...)`). Rules:

1. **Tenant list / detail paths** always include `orgId` as the leading key and filter active
   rows with a partial filter `{ status: 'A' }` when the datastore supports it.
2. **Keyset pagination** (see §4.6) uses a stable sort on `createdAt` + `_id` (or
   `updatedAt` + `_id` when the list is “recently updated”); the matching compound index must
   exist on that collection.
3. **Uniqueness** that is tenant-scoped is always `{ orgId, … }` with partial `status: 'A'`.
4. **Production:** `autoIndex: false`. Indexes are never created by Mongoose auto-create in
   production.
5. **Development:** app startup calls `syncSchemaIndexes` for registered models. The test
   harness does the same in `beforeAll`.
6. **Pre–go-live:** dropping or reshaping an index is a schema edit + re-sync against the
   shared MongoDB. Introduce a versioned migration runner only when production needs
   controlled, auditable schema changes.

Base / tenant plugin **does not** auto-add indexes to every schema. The shapes below are
**templates** — a domain phase applies each only when that list/filter path exists. A fixture
tenant schema in tests may declare them to prove the convention:

```text
{ orgId: 1, createdAt: -1, _id: -1 }   partial status: 'A'   // default list keyset
{ orgId: 1, updatedAt: -1, _id: -1 }   partial status: 'A'   // recently-updated lists
{ orgId: 1, createdBy: 1 }             partial status: 'A'   // “created by me” when needed
```

Domain phases add their own unique and query indexes on top of these conventions.

### 4.5 Integration-test harness (**D16**)

`backend/src/test/mongoHarness.js`:

1. Read `MONGODB_URI` from the same validated config as the app.
2. Parse the URI and **substitute the database name** with constant `TEST_DATABASE_NAME`
   (`codex_sage_test`). No new env var.
3. Connect with the same mongoose options as production (pool constants from Phase 01).
4. `beforeAll`: connect once per Vitest worker; sync indexes for models under test.
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

No product collection in this phase. Conventions only:

### Base fields (every domain document)

| Field | Type | Notes |
|---|---|---|
| `status` | `'A' \| 'D'` | default `'A'` |
| `createdAt` | Date | UTC |
| `updatedAt` | Date | UTC |
| `createdBy` | ObjectId \| null | userId; null for system/bootstrap |
| `updatedBy` | ObjectId \| null | userId; null for system/bootstrap |

### Tenant fields (tenant-scoped collections)

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | required; short tenant key |

### Index templates (apply only when the list path exists)

| Index | Partial | Purpose |
|---|---|---|
| `{ orgId: 1, createdAt: -1, _id: -1 }` | `status: 'A'` | Default list keyset |
| `{ orgId: 1, updatedAt: -1, _id: -1 }` | `status: 'A'` | Recently-updated lists |
| `{ orgId: 1, createdBy: 1 }` | `status: 'A'` | Filter by creator (when needed) |

Not every tenant collection gets all three. Domain unique and query indexes are owned by later
phases and must still lead with `orgId` when tenant-scoped.

## 6. API contract — PROPOSED (needs approval before implementation)

**No HTTP endpoint.** Internal contracts:

- `createBaseSchema(definition, options)` → schema with plugins + declared indexes.
- `includeDeleted(query)` → query that may see `status: 'D'`.
- `softDelete(filter, { updatedBy })` → sets `status: 'D'` only on `status: 'A'` matches.
- `encodeCursor` / `decodeCursor`.
- `syncSchemaIndexes(models)` → explicit index sync for dev/test (and deliberate ops use).
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
| `backend/src/platform/data/baseSchema.js` | **New:** plugins + `createBaseSchema` + index helpers |
| `backend/src/platform/data/baseSchema.test.js` | **New:** defaults, soft-delete, timestamps, actors, indexes |
| `backend/src/platform/data/cursors.js` | **New:** keyset encode/decode |
| `backend/src/platform/data/cursors.test.js` | **New:** round-trip, invalid cursor |
| `backend/src/platform/data/syncIndexes.js` | **New:** explicit index sync helper |
| `backend/src/platform/data/syncIndexes.test.js` | **New:** creates declared indexes; idempotent |
| `backend/src/test/mongoHarness.js` | **New:** URI rewrite + connect/cleanup + index sync |
| `backend/src/test/mongoHarness.test.js` | **New:** refuses non-test db name; rewrites path |
| `backend/src/platform/mongo.js` | **Change:** `autoIndex` off in production |

## 9. Tests (≥ 80% line and branch)

### Unit

- Base schema default `status: 'A'`; rejecting any other value.
- Soft-delete hides the row from default `find`; `includeDeleted` still sees it.
- `updatedAt` / `updatedBy` change on update; stored timestamp is UTC.
- Insert stamps `createdBy`; update stamps `updatedBy`.
- Insert without `orgId` on a tenant schema throws `TENANT_SCOPE_MISSING`.
- Cursor round-trip; malformed cursor → `INVALID_CURSOR`.
- Declared compound indexes are present after `syncSchemaIndexes` (fixture tenant model).

### Integration (harness)

- Connecting through the harness uses database `codex_sage_test`.
- A document written in a test is gone after `afterEach`.
- The development database named in the original URI has no new collections from the suite.
- A URI whose rewritten name would not be `codex_sage_test` is rejected.
- Fixture tenant indexes exist after harness `beforeAll` sync.

### Unhappy paths

- `softDelete` on an already-`'D'` row matches zero documents.
- Soft delete without `updatedBy` still succeeds when the caller is system (null actor).

## 10. Definition of Done

- [ ] Every new model in later phases can be built with `createBaseSchema`; there is one
      definition of row `status`, timestamps, and `createdBy` / `updatedBy`.
- [ ] Default queries never return `status: 'D'`.
- [ ] Tenant schemas require `orgId`; `organizations` opts out of the tenant plugin.
- [ ] Indexes are declared on schemas; production mongoose sets `autoIndex: false`;
      development startup and the harness call `syncSchemaIndexes`.
- [ ] No versioned migration runner or `backend/migrations/` folder in this phase.
- [ ] Integration tests use `codex_sage_test` on the external replica set; no
      `mongodb-memory-server` dependency.
- [ ] The harness refuses to run against any other database name.
- [ ] No new `.env` keys.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- Create `docs/data-model.md` with the row-status rule, UTC timestamps, actor fields,
  `orgId` tenant-key rule, and index conventions (schema-declared; migrations deferred until
  go-live).
- `docs/architecture.md` §3: note that pre–go-live schema/index changes are schema-driven;
  versioned migrations are deferred.
- Align `.cursor/rules/data-model.mdc` when this phase lands (migrations rule becomes
  go-live / production posture, not day-one).
- No new ADR expected; MongoDB as datastore is Phase 04.

## 12. Risks & open questions

### Decided

1. **`createdBy` / `updatedBy` nullability** — null allowed for system/bootstrap; stamp from
   authenticated `userId` when present.
2. **Field name** — `orgId` everywhere (Mongo, repos, principal, API JSON). JWT claim key
   stays short `org` and carries that id.
3. **Dev index sync** — development startup calls `syncSchemaIndexes`; production does not
   auto-create indexes.
4. **Plan-wide rename** — later phase docs and convention sources use `orgId`,
   `createdBy` / `updatedBy`, and schema-declared indexes (no versioned migrations pre–go-live).

### Still open

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Test cleanup:** `deleteMany` per collection vs `dropDatabase` on `codex_sage_test` after
   the suite. Drop is faster and complete; delete is safer if two suites share the name.
   Proposal: drop the test database in `afterAll` of the global setup, plus `deleteMany` in
   `afterEach` for isolation inside a file.
2. **Global mongoose plugins vs per-schema.** Proposed: per-schema via `createBaseSchema` so
   a platform collection can opt out. Confirm.
3. **Cursor payload.** Proposed: `{ t: iso, i: hexObjectId }` then base64url. Confirm before
   Phase 11 freezes the header/query format.
