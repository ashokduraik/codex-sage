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
`passwordUpdatedAt`, `mustChangePassword` (boolean, default `false`; set on admin-set
password, cleared on self-service change), `userStatus` (`active` \| `invited` \|
`disabled`), `lastLoginAt`, plus base fields. Unique partial index on
`{ orgId: 1, email: 1 }` where `status: 'A'`. List/keyset indexes:
`{ orgId: 1, status: 1, createdAt: -1, _id: -1 }`, `{ orgId: 1, displayName: 1 }`,
plus `{ orgId: 1, status: 1, _id: -1 }` and `{ orgId: 1, userStatus: 1, _id: -1 }`.
Email is mutable after create (admin `PATCH`); no `passwordHistory` in this slice
(`PASSWORD_HISTORY_LENGTH = 0`).

### `roles`

Tenant-scoped. Built-in roles use `isBuiltIn: true` and `builtInKey` (`org_admin`,
`project_admin`, `member`, `viewer`) with empty `permissions` (resolved from code — see
[`permissions.md`](./permissions.md)). Custom roles store `permissions`. Unique partial
indexes on `{ orgId: 1, name: 1 }` and `{ orgId: 1, builtInKey: 1 }` (built-ins only).
Keyset list index: `{ orgId: 1, status: 1, createdAt: -1, _id: -1 }`. Built-in roles may
change `description` only; name, permissions, and soft-delete are immutable.

### `memberships`

Tenant-scoped. Fields: `userId`, `roleIds` (one or more), plus base fields. Unique partial
index on `{ orgId: 1, userId: 1 }` where `status: 'A'`.

### `sessions`

Tenant-scoped refresh-token rows (Phase 07 / ADR 0012). Fields: `userId`, `familyId`,
`refreshTokenHash` (SHA-256 of the opaque token — never the raw value), `issuedAt`,
`expiresAt`, optional `rotatedAt` / `replacedBySessionId`, optional `revokedAt` /
`revokedReason` (`logout` \| `reuse_detected` \| `password_changed` \| `user_disabled` \|
`email_changed`), plus base fields. Indexes: unique `{ refreshTokenHash: 1 }`;
`{ orgId: 1, userId: 1, status: 1 }`; `{ familyId: 1 }`; `{ expiresAt: 1 }`.

### `idempotencyRecords`

Tenant-scoped platform rows for `Idempotency-Key` replay across PM2 workers and API hosts
(Phase 12). Fields: `userId`, `route` (method + path template), `key`, `requestHash`,
`recordState` (`processing` \| `completed`), `responseStatus`, `responseBody` (capped),
`resourceId`, `expiresAt`, plus base fields. Unique partial index on
`{ orgId: 1, userId: 1, route: 1, key: 1 }` where `status: 'A'`. TTL index on `{ expiresAt: 1 }`
(hard expiry of non–user-facing rows). Soft-delete (`status: 'D'`) releases an in-flight claim
when the owner request fails.

### `projects`

Tenant-scoped (Phase 17). Fields: `name` (1–120), `description` (≤ 2000), `lifecycleStatus`
(`creating` \| `awaiting_source` \| `connecting_repository` \| `source_received` \|
`processing` \| `knowledge_ready` \| `updating` \| `failed` \| `partially_available` \|
`archived`), `preArchiveLifecycleStatus`, `lifecycleStatusReasonCode`,
`lifecycleStatusChangedAt`, `knowledgeHealth` (`none` \| `updating` \| `ready` \|
`partially_available` \| `stale` \| `failed`), `currentKnowledgeVersionId`, `sourceConfig`
(`sourceType`: `upload` \| `repository`, optional connection/version refs), `settings`
(key registry starts empty), `counts` (`sourceVersions`, `files`, `excludedFiles`,
`conversations` — written only by owning phases), `archivedAt`, plus base fields.

Names are **not** unique within an org (duplicates allowed). Soft-delete sets `status: 'D'`
and leaves `lifecycleStatus` unchanged. Archive stores `preArchiveLifecycleStatus` and sets
`archivedAt`; restore returns to that prior state.

Indexes (partial `status: 'A'`): `{ orgId: 1, updatedAt: -1, _id: -1 }` (list keyset),
`{ orgId: 1, lifecycleStatus: 1 }` (dashboard grouping).

Lifecycle transitions are enforced by `transitionLifecycle` (API vs worker source; worker +
`knowledgeVersionId` required for `knowledge_ready` / `partially_available`). Worker publish
also sets `knowledgeHealth` on the same transition.

### `knowledgeVersions`

Tenant- and project-scoped published graph metadata (Phase 28). Fields: `projectId`,
`sourceVersionId`, `graphIdentity` (`graphHash`, `indexedAt`, `sourceVersionId`,
`indexedFileCount`, `skippedFileCount`, `mode`, `graphDir` — relative `.codegraph` only, no
absolute paths), `publishedHealth` (`ready` \| `partially_available` \| `failed`),
`excludedFileCount`, `publishedAt`, plus base fields.

Current knowledge for a project is **`projects.currentKnowledgeVersionId`** — prior rows stay
`status: 'A'` until retention purge (Phase 60).

Indexes (partial `status: 'A'`): `{ orgId, projectId, publishedAt: -1, _id: -1 }`;
`{ orgId, projectId, sourceVersionId }`.

### `sourceVersions`

Tenant- and project-scoped upload/repository snapshot (Phase 24). Fields: `projectId`,
`origin` (`upload` \| `repository`), `exclusionRulesetId` (e.g. `exclusions.v1`),
`versionLifecycle` (`received` \| `failed` \| `accepted` — domain; not row `status`),
`jobId` (pending ingest job), `fileCounts` (`accepted`, `skipped`, `excludedFromGraph`),
plus base fields. Skipped paths are counted only here — they are never stored as
`sourceFiles` or GridFS objects.

Index (partial `status: 'A'`): `{ orgId, projectId, createdAt: -1 }`.

### `sourceFiles`

One accepted path within a `sourceVersion` (Phase 24). Fields: `projectId`,
`sourceVersionId`, `path` (normalized relative), `sha256`, `byteLength`,
`kind` (`code` \| `config` \| `doc`), `gridFsId`, `excludedFromGraph`,
`exclusionReason` (e.g. `file_too_large`), `fileState` (`stored` \| `missing` \|
`corrupt`), `orphanedAt`, plus base fields.

Unique index (partial `status: 'A'`): `{ orgId, projectId, sourceVersionId, path }`.

### `documentSections`

Searchable documentation slices for a `sourceVersion` (Phase 26). Fields: `projectId`,
`sourceVersionId`, `path` (normalized relative), `heading` (string or null), `startLine`,
`endLine` (inclusive), `text` (plain searchable text, length-capped), `sectionIndex`
(0-based order within the file), plus base fields.

Indexes (partial `status: 'A'` where noted): unique
`{ orgId, projectId, sourceVersionId, path, sectionIndex }`; list
`{ orgId, projectId, sourceVersionId, status }`; MongoDB text index
`document_sections_text` on `{ text, heading }` with weights `{ text: 10, heading: 5 }`
(phase 38 query filters still scope by org/project/version/`status: 'A'`).

Only `.md` / `.mdx` / `.txt` paths create rows; code files are materialized to the workspace
but do not produce sections. Fresh S3 rematerialize soft-deletes prior active rows for the
version before rewrite.

### GridFS bucket `sourceFiles`

Accepted source/doc bytes only (ADR 0003). Filename =
`{orgId}/{projectId}/{sourceVersionId}/{normalizedPath}`. File `metadata`:
`{ orgId, projectId, sourceVersionId, path, sha256 }` (optional `orphanedAt` after a
failed write). GridFS files are not soft-deleted via row `status`; purge is a later ADR.

### `jobs`

Tenant- and project-scoped background work (Phase 20; ADR 0004). Row `status` (`A` \| `D`)
is visibility only; lifecycle is `jobStatus` (`pending` \| `running` \| `completed` \|
`completed_with_warnings` \| `failed` \| `retrying` \| `cancelled`). Failed jobs stay
`status: 'A'` and remain readable.

Fields: `projectId`, `jobType` (`ingest` \| `reingest` \| `repo_sync` \| `worker_smoke`, …), `jobStatus`,
`sourceVersionId`, `correlationId`, worker lease fields (`workerId`, `attempt`,
`maxAttempts`, `heartbeatAt`, `leaseExpiresAt`, `scheduledAt`), `failureClass` /
`failureCode`, `currentStage`, `stageCheckpoint`
(`{ lastCompletedStage, cursor?, updatedAt }` — resume after `lastCompletedStage`; no
`completedStages[]`), `progressCounters` (`itemsProcessed`, `itemsFailed`,
`warningCount`, `excludedCount`), `partialSuccess`, `cancelRequestedAt`, `startedAt`,
`completedAt`, plus base fields. `workerId` is operational and is **not** returned on read
APIs.

Indexes (partial `status: 'A'`): `{ orgId, projectId, createdAt: -1, _id: -1 }` (list
keyset), `{ orgId, projectId, jobStatus }` (dashboard), `{ orgId, projectId, jobStatus,
currentStage }` (stage filter), `{ status, jobStatus, jobType,
scheduledAt }` (claim), `{ status, jobStatus, leaseExpiresAt }` (sweep).

Internal `createPendingJob` inserts `pending` + a `job.enqueued` event. Phase 21 claims,
heartbeats, sweeps expired leases, and serializes exclusive writers via
`project_job_locks`. Cancel/retry HTTP control is Phase 22.

### `job_events`

Append-only history for a job (Phase 20). Fields: `projectId`, `jobId`, `eventCode`,
`severity` (`info` \| `warning` \| `error`), `message` (user language, capped; never
truncated), `data` (structured allowlisted keys), `correlationId`, plus base fields.
Index (partial `status: 'A'`): `{ orgId, jobId, createdAt: 1 }`.

### `project_job_locks`

Job-level per-project writer lock (Phase 21; ADR 0022). Fields: `projectId`, `jobId`,
`workerId`, `lockScope` (`project_writer`), `acquiredAt`, `expiresAt`, plus base fields
including row `status` (`A` \| `D`). Soft-delete releases the unique key for the next
writer. Indexes: unique `{ orgId, projectId, lockScope }` partial `status: 'A'`;
`{ expiresAt: 1 }` for expired-lock takeover.

## Bootstrap seed

On API startup the process ensures the default organization, four built-in roles, admin
user (password hashed from the named constant `DEFAULT_ADMIN_PASSWORD`, `userStatus: 'active'`),
and org_admin membership exist (ADR 0011). Defaults are named constants — not env vars.
Worker processes do not seed.
