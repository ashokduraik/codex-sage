# Data model conventions

Shared MongoDB / Mongoose conventions for codex-sage. Domain collections are listed as they
land; every document inherits the base fields below.

## Row status

| Value | Meaning |
|---|---|
| `A` | Active (visible) — default on insert |
| `D` | Soft-deleted (hidden from default queries) |

- Domain lifecycle (`userStatus`, `lifecycleStatus`, `jobStatus`, …) **never** overloads
  `status`.
- Soft delete sets `status: 'D'` on active rows only; list/detail queries default to
  `status: 'A'`. Use `includeDeleted()` to opt in.
- Hard purge of user-facing resources requires a separate ADR.

## Timestamps and actors

| Field | Notes |
|---|---|
| `createdAt` / `updatedAt` | UTC BSON Dates (ISO-8601 with `Z` at the API edge) |
| `createdBy` / `updatedBy` | ObjectId → user, or `null` for system/bootstrap writes |

## Tenant key

- Tenant-scoped collections require `orgId` (ObjectId).
- `organizations` opts out: its `_id` **is** the org id other collections store as `orgId`.
- Repositories for tenant collections require `orgId` on every read/write
  (`TENANT_SCOPE_MISSING` when omitted).

## Indexes

- Declared on the Mongoose schema (`schema.index(...)`).
- Production: `autoIndex: false`. Development startup and the integration-test harness call
  `syncSchemaIndexes`.
- Tenant unique / list indexes lead with `orgId` and use a partial filter `{ status: 'A' }`
  when applicable.
- Pre–go-live: schema edit + re-sync. A versioned migration runner is deferred until
  production cutover.

## Keyset cursors

Opaque cursors encode `{ t: isoTimestamp, i: objectIdHex }` as base64url (`encodeCursor` /
`decodeCursor`). Invalid input throws `INVALID_CURSOR`.

## Integration tests

Same external MongoDB 8 replica set as development; database name forced to
`codex_sage_test` (see ADR 0009). No `mongodb-memory-server`.

## Collections

### `organizations`

Opts out of the tenant `orgId` plugin (`_id` is the org id). Fields: `name`, `slug`, `config`,
plus base fields. Unique partial index on `{ slug: 1 }` where `status: 'A'`.

### `users`

Tenant-scoped. Fields: `email`, `displayName`, `passwordHash` (`select: false`),
`passwordUpdatedAt`, `userStatus` (`active` \| `invited` \| `disabled`), `lastLoginAt`, plus
base fields. Unique partial index on `{ orgId: 1, email: 1 }` where `status: 'A'`.

### `roles`

Tenant-scoped. Built-in roles use `isBuiltIn: true` and `builtInKey` (`org_admin`,
`project_admin`, `member`, `viewer`) with empty `permissions` (resolved in Phase 09). Custom
roles store `permissions`. Unique partial indexes on `{ orgId: 1, name: 1 }` and
`{ orgId: 1, builtInKey: 1 }` (built-ins only).

### `memberships`

Tenant-scoped. Fields: `userId`, `roleIds` (one or more), plus base fields. Unique partial
index on `{ orgId: 1, userId: 1 }` where `status: 'A'`.

## Bootstrap seed

On API startup the process ensures the default organization, four built-in roles, invited
admin user, and org_admin membership exist (ADR 0011). Defaults are named constants — not
env vars. Worker processes do not seed.
