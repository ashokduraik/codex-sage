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
| `createdBy` / `updatedBy` | ObjectId → `User`, or `null` for system/bootstrap writes |

## Tenant key

- Tenant-scoped collections require `orgId` (ObjectId → `Organization`).
- `organizations` opts out: its `_id` **is** the org id other collections store as `orgId`.
- Repositories for tenant collections require `orgId` on every read/write
  (`TENANT_SCOPE_MISSING` when omitted).

## ObjectId fields

- Declare `const ObjectId = mongoose.Schema.Types.ObjectId` once at the top of each
  schema file. Field definitions use `type: ObjectId`, not `mongoose.Schema.Types.ObjectId`.
- Every ObjectId that points at a domain document sets `ref` to the registered Mongoose
  model name (`User`, `Project`, `Organization`, `Job`, …).
- Omit `ref` only for non-document ids (GridFS `gridFsId`) or polymorphic ids with no
  single model (`resourceId` on idempotency records).

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

Opts out of the tenant `orgId` plugin (`_id` is the org id). Fields: `code` (uppercase
`[A-Z0-9_-]{2,64}`, set on create only), `name`, `slug`, `config`, `aclVersion`,
`retentionPolicy` (embedded: `readySourceVersionsKeep` default 3, `jobDays` 180,
`notificationDays` 90, `notificationReadDays` 30, `usageDays` 730, `conversationDays` 365,
`auditDays` 730 — admins with `org.manage` may PATCH), plus base fields.
Unique partial indexes on `{ slug: 1 }` and `{ code: 1 }` where `status: 'A'`. Seeded
org uses `code: "DEFAULT_ORG"`. See ADR 0032 and Phase 60.

### `users`

Tenant-scoped. Fields: `code` (uppercase `[A-Z0-9_-]{2,64}`, set on create only),
`email`, `displayName`, `passwordHash` (`select: false`),
`passwordUpdatedAt`, `mustChangePassword` (boolean, default `false`; set on admin-set
password, cleared on self-service change), `userStatus` (`active` \| `invited` \|
`disabled`), `lastLoginAt`, `roleIds` (one or more org roles), `projectAccessMode`
(`all` \| `selected` \| `none`, default `selected`), plus base fields. Unique partial
indexes on `{ orgId: 1, email: 1 }` and `{ orgId: 1, code: 1 }` where `status: 'A'`.
List/keyset indexes:
`{ orgId: 1, status: 1, createdAt: -1, _id: -1 }`, `{ orgId: 1, displayName: 1 }`,
plus `{ orgId: 1, status: 1, _id: -1 }` and `{ orgId: 1, userStatus: 1, _id: -1 }`.
Role-in-use / list-by-role index: `{ orgId: 1, roleIds: 1 }`. Email is mutable after
create (admin `PATCH`); `code` is not. No `passwordHistory` in this slice
(`PASSWORD_HISTORY_LENGTH = 0`). Seeded admin uses `code: "ADMIN"`. See ADR 0028
and ADR 0032.

### `roles`

Tenant-scoped. Fields: `code` (uppercase `[A-Z0-9_-]{2,64}`, set on create only),
`name`, `description`, `permissions` (catalog keys stored on the document), plus
base fields. Seed creates one role with `code: "ADMIN"` and every catalog
permission. Admins may create any number of additional roles with any catalog
subset. Unique partial indexes on `{ orgId: 1, name: 1 }` and `{ orgId: 1, code: 1 }`
where `status: 'A'`. Keyset list index: `{ orgId: 1, status: 1, createdAt: -1, _id: -1 }`.
Name, description, permissions, and soft-delete are writable on every role; `code`
is immutable after create. Soft-delete fails with `ROLE_IN_USE` while any
row-status-A user still holds the role. See ADR 0032.

### `loginsessions`

Tenant-scoped one-document-per-sign-in rows (Phase 07 / ADR 0030). Fields: `userId`,
`loggedInAt`, `expiresAt` (absolute end of the login), `tokens[]` (`_id`,
`refreshTokenHash` SHA-256 of the opaque token — never the raw value, `issuedAt`, optional
`rotatedAt`), optional `loggedOutAt` (user logout only), optional `revokedAt` /
`revokedReason` (`reuse_detected` \| `password_changed` \| `user_disabled` \|
`email_changed`), plus base fields. Indexes: unique `{ tokens.refreshTokenHash: 1 }`;
`{ orgId: 1, userId: 1, status: 1 }`; `{ expiresAt: 1 }`.

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
`conversations` — written only by owning phases), `archivedAt`, `members[]` (per-project
ACL overlay: `userId`, optional `roleId`, `permissions[]`, `addedByUserId`, subdoc
`status` `A`\|`D`, `createdBy` / `updatedBy` / `createdAt` / `updatedAt`; keep `_id` so
re-add reuses the same grant id), plus base fields.

Names are **not** unique within an org (duplicates allowed). Soft-delete sets `status: 'D'`
and leaves `lifecycleStatus` unchanged. Archive stores `preArchiveLifecycleStatus` and sets
`archivedAt`; restore returns to that prior state. Removing a member sets that subdoc
`status: 'D'` (tombstone stays on the project). Leftover `project_members` collection is
dropped; there is no copy job.

Indexes (partial parent `status: 'A'`): `{ orgId: 1, updatedAt: -1, _id: -1 }` (list
keyset), `{ orgId: 1, lastAccessedAt: -1, _id: -1 }`, `{ orgId: 1, lifecycleStatus: 1 }`
(dashboard grouping), `{ orgId: 1, 'members.userId': 1 }` (accessible-project filter).
Active uniqueness (one `status: 'A'` grant per user) is enforced on `$push`, not by a
unique index.

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
`status: 'A'` until retention (Phase 60) keeps the last **3** ready versions and soft-deletes
older ones (and their `sourceFiles`). GridFS bytes are not hard-purged.

Indexes (partial `status: 'A'`): `{ orgId, projectId, publishedAt: -1, _id: -1 }`;
`{ orgId, projectId, sourceVersionId }`.

### `sourceVersions`

Tenant- and project-scoped upload/repository snapshot (Phase 24 / 32). Fields:
`projectId`, `origin` (`upload` \| `repository`), `exclusionRulesetId` (e.g.
`exclusions.v1`), `versionLifecycle` (`received` \| `failed` \| `accepted` —
domain; not row `status`), `jobId` (pending ingest job), `commitSha`, `branch`,
`repositoryConnectionId` (set when `origin` is `repository`), `fileCounts`
(`accepted`, `skipped`, `excludedFromGraph`), plus base fields. Provider
(`github` \| `gitlab`) lives on the connection, not on `origin`. Skipped paths
are counted only here — they are never stored as `sourceFiles` or GridFS objects.

Index (partial `status: 'A'`): `{ orgId, projectId, createdAt: -1 }`.
`GET /api/v1/knowledge/sources/listVersions/:projectId` lists active rows (permission
`projects.view`) with that keyset.

### `sourceChangeSummaries`

Persisted path+sha256 diff for an incoming `sourceVersion` versus the last published
source (Phase 29). Fields: `projectId`, `sourceVersionId` (incoming),
`previousSourceVersionId`, `knowledgeVersionId` (published base, may be null),
`counts` (`added`, `removed`, `changed`, `unchanged`), `paths` (same keys, string
arrays), `computedAt`, `diffStatus` (`pending` \| `computed` \| `failed`), plus
base fields.

Unique index (partial `status: 'A'`): `{ orgId, projectId, sourceVersionId }`.
List index (partial `status: 'A'`): `{ orgId, projectId, createdAt: -1 }`.

Used by ingest to populate `carry.skipPaths` / `changedPaths` / `removedPaths` on
new-upload jobs. Reingest does not write a skip-path summary (full rebuild).
Phase 39 reads these rows for `GET /projects/:projectId/knowledge/updates/latest`
(no schema change). The HTTP DTO maps `counts.changed` → `modified` and leaves
API/workflow impact fields `null` until an impact graph exists.

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

Fields: `projectId` (null for org-scoped `aged_org_data_cleanup` jobs), `jobType` (`project_knowledge_build` \| `project_knowledge_rebuild` \| `connected_repo_pull` \| `worker_smoke_check` \| `aged_org_data_cleanup`), `jobStatus`,
`sourceVersionId`, `correlationId`, worker lease fields (`workerId`, `attempt`,
`maxAttempts`, `heartbeatAt`, `leaseExpiresAt`, `scheduledAt`), `failureClass` /
`failureCode`, `currentStage`, `stageCheckpoint`
(`{ lastCompletedStage, cursor?, updatedAt }` — resume after `lastCompletedStage`; no
`completedStages[]`), `progressCounters` (`itemsProcessed`, `itemsFailed`,
`warningCount`, `excludedCount`), `partialSuccess`, `cancelRequestedAt`, `startedAt`,
`completedAt`, plus base fields. `workerId` is operational and is **not** returned on read
APIs.

`events[]` is the user-readable timeline on the same document (stage lines such as
`job.enqueued`, `source.validated`). Each line has `eventCode`, `severity`
(`info` \| `warning` \| `error`), `message` (user language, capped; never truncated),
`data` (allowlisted keys), `correlationId`, and `createdAt`. Append with `$push` only;
do not rewrite the array on heartbeat or claim. Soft-deleting the job hides the timeline.
A leftover `job_events` collection from before this embed may be dropped.

Indexes (partial `status: 'A'`): `{ orgId, projectId, createdAt: -1, _id: -1 }` (list
keyset), `{ orgId, projectId, jobStatus }` (dashboard), `{ orgId, projectId, jobStatus,
currentStage }` (stage filter), `{ status, jobStatus, jobType,
scheduledAt }` (claim), `{ status, jobStatus, leaseExpiresAt }` (sweep).

Internal `createPendingJob` inserts `pending` with a `job.enqueued` line in `events`.
Phase 21 claims, heartbeats, sweeps expired leases, and serializes exclusive writers via
`project_job_locks`. Cancel/retry HTTP control is Phase 22.

### `project_job_locks`

Job-level per-project writer lock (Phase 21; ADR 0022). Fields: `projectId`, `jobId`,
`workerId`, `lockScope` (`project_writer`), `acquiredAt`, `expiresAt`, plus base fields
including row `status` (`A` \| `D`). Soft-delete releases the unique key for the next
writer. Indexes: unique `{ orgId, projectId, lockScope }` partial `status: 'A'`;
`{ expiresAt: 1 }` for expired-lock takeover.

### `repositoryConnections`

One **active** attached repository per project (Phase 31). Fields: `projectId`,
`provider` (`github` \| `gitlab`), `hostKind` (`github` \| `gitlab_saas` \|
`gitlab_self_hosted`), `baseUrl` (self-hosted origin or null),
`repositoryFullName`, `repositoryWebUrl`, `visibility`, `selectedBranch`,
`defaultBranchAtAttach`, `connectionStatus` (`connected` \|
`authentication_required` \| `access_denied` \| `not_found` \| `unreachable`),
`connectionStatusReasonCode`, `credential` (nested encrypted PAT or null),
`attachedBy`, `attachedAt`, `lastSuccessfulProbeAt`, `branchChangedAt`,
`lastSyncedCommitSha`, `lastSyncedAt`, `nextDueAt` (defaults to attach time so
the first sync is due immediately), `lastSyncJobId`, `lastSyncErrorCode`, plus
base fields. Domain `connectionStatus` is not row `status`.

`credential` is a nested object (`ciphertext`, `iv`, `authTag`, `keyId`,
`credentialKind` (`pat` only), `lastValidatedAt`, `revokedAt`) or null when
attach stored no token (ADR 0029). Never joined into list or connection
DTOs. Decrypt only in memory. Replace overwrites the nested object (no
historical ciphertext). Revoke soft-deletes the connection and leaves
`credential` as-is on the tombstone.

Unique index (partial `status: 'A'`): `{ orgId, projectId }`.
List index (partial `status: 'A'`): `{ orgId, projectId, status }`.
Due-scan index (partial `status: 'A'`): `{ nextDueAt }`.

Soft-delete (revoke) sets `status: 'D'` and clears
`projects.sourceConfig.repositoryConnectionId`. Worker `connected_repo_pull` reads this
row, downloads a provider archive (ADR 0026), and enqueues `project_knowledge_build`.

### `conversations`

Owner-private chat thread header (Phases 41–42; ADR 0027). Fields: `projectId`,
`ownerUserId` (same as `createdBy` on create), `title` (1–200), `titleSource`
(`default` \| `user` \| `truncated_user_text` \| `llm`), `searchText` (denormalized
message contents for the text index; maintained when messages persist),
`lifecycleStatus` (`active` \| `archived`), `archivedAt`, `lastMessageAt`,
`messageCount`, `context` (Phase 44: `summaryText`, `summaryUpdatedAt`,
`summaryCoversThroughMessageId`, `pinnedFacts[]` of `{ id, text,
source: 'clarification' \| 'user_correction', messageId?, createdAt }`), plus
base fields. `context` defaults to an empty summary and no pins. Conversation
content never writes project knowledge.

Row `status` is never used for archive. Default list is `status: 'A'` and
`lifecycleStatus: 'active'`; `?archived=true` returns archived rows only.
Soft-delete sets `status: 'D'` and decrements `projects.counts.conversations`.
Messages remain until retention (Phase 60).

Indexes (partial `status: 'A'`): `{ orgId, projectId, ownerUserId, updatedAt: -1, _id: -1 }`,
`{ orgId, projectId, ownerUserId, lifecycleStatus, updatedAt: -1 }`.
Text index `conversation_search_text` on `title` (weight 10) + `searchText` (weight 5).

Conversations do not write `KnowledgeVersion` or other project knowledge.

### `messages`

One row per chat turn (Phase 41 schema; HTTP create is Phase 50; queue is Phase 51;
edit/retry is Phase 53).
Fields: `projectId`, `conversationId`, `role` (`user` \| `assistant` \| `system`), `content`,
`messageStatus` (`queued` \| `accepted` \| `generating` \| `awaiting_clarification` \|
`completed` \| `abstained` \| `failed` \| `interrupted`), `knowledgeVersionId`,
`parentMessageId` (assistant turn replies to this user message),
`editedAt` (null until the user edits that user message in place),
`editGeneration` (number, default `0`; increments on each successful edit),
`queuedAt` / `expiresAt` / `blockingJobId` / `queueFailureCode` (null unless queued or
queue-failed; Phase 51),
optional `evidence` / `usage` / `contextMetrics` / `supportLevel` /
`durationMs` / `modelId` / `trace` (null until written), plus base fields.
`supportLevel` is `evidence_backed` \| `insufficient` \| `conflict` \| `partial`.
`trace` is Mixed for §146 linkage (`userMessageId`, `knowledgeVersionId`, `evidenceIds[]`,
`stages[]`, `correlationId`) — never private model reasoning.
`contextMetrics` is Mixed: when Phase 43 accounting succeeds it holds
`validatedContextCapacity`, `measuredInputTokens`, `maximumInputBudget`,
`reservedOutputTokens`, `compactionActions[]`, and `contextPercentUsed` (0–1)
only when the budget denominator exists. `usage` is provider-reported tokens
(Phase 45). The UI omits null reserved keys.

Indexes (partial `status: 'A'`): `{ orgId, conversationId, createdAt: 1, _id: 1 }`,
`{ orgId, projectId, conversationId }`,
`{ orgId, projectId, messageStatus, queuedAt }` (queue drain / expiry),
`{ orgId, projectId, blockingJobId, messageStatus }` (fail by writer job).
Thread pages are oldest-first on `(createdAt, _id)`.

### `clarificationSets`

User-visible clarification questions and submitted answers for one assistant turn
(Phase 52). Used so refresh can rehydrate the wizard and so answer POST can
validate and resume the paused chat run. Not LangGraph checkpoints, not message
content, and not private model reasoning.

Fields: `projectId`, `conversationId`, `messageId` (assistant row),
`clarificationSetId` (public id matching SSE/graph), `roundIndex` (`0` \| `1`),
`setStatus` (`open` \| `answered` \| `superseded`), `questions[]`
(`id`, `type`, `prompt`, optional `options` string[], `required`), `answers`
(Mixed map questionId → string \| string[]; null until POST), `issuedAt`, plus
base fields.

Indexes (partial `status: 'A'`): unique `{ orgId, clarificationSetId }`;
`{ orgId, messageId, setStatus }` for open-set lookup.

ListMessages embeds the open set on awaiting assistant DTOs as
`clarification: { clarificationSetId, roundIndex, questions }` (not a message
schema field).

### `chatCheckpoints`

Durable LangGraph snapshots for one chat answer run (Phase 47; ADR 0035). Used so
clarification pause and client disconnect can resume the same run. Not the
user-visible clarification Q&A document (Phase 52), not message content, and not
private model reasoning.

Fields: `threadId` (`{orgId}:{conversationId}:{assistantMessageId}`),
`checkpointNs` (default `''`), `checkpointId`, `parentCheckpointId` (null at
root), `checkpoint` (Mixed — serialized saver blob), `metadata` (Mixed — product
hints plus LangGraph metadata / pending writes), plus base fields.

Indexes (partial `status: 'A'`): unique `{ orgId, threadId, checkpointId }`;
list `{ orgId, threadId, createdAt: -1 }`.

### `notifications`

Tenant- and user-scoped inbox rows (Phase 58). Fields: `userId`, `type`
(`knowledge.completed` \| `knowledge.failed` \| `repo.sync.completed` \|
`repo.sync.failed` \| `processing.attention`), `title`, `body`, `resourceRef`
(`projectId`, optional `jobId` / `sourceVersionId`), `readAt`, `dedupeKey`, plus
base fields. Unique partial index `{ orgId, userId, dedupeKey }` where
`status: 'A'`. List index `{ orgId, userId, status, createdAt: -1, _id: -1 }`.
Retention (Phase 60) soft-deletes unread rows after 90 days, or 30 days after
`readAt`, whichever is first.

### `projectActivities`

One observed project fact (Phase 59): ingest, search, answered question, or LLM
tokens when the SDK reports them. Fields: `projectId` (required), `userId`
(null when the actor is unknown), `kind` (`ingest.job.completed` \|
`source.bytes.accepted` \| `search.executed` \| `question.answered` \|
`tokens.input` \| `tokens.output`), `quantity`, `unit`, `sourceRef`, `dedupeKey`,
`occurredAt`, plus base fields. Unique partial index `{ orgId, dedupeKey }`
where `status: 'A'`. List indexes `{ orgId, projectId, occurredAt: -1 }` and
`{ orgId, userId, occurredAt: -1 }` where `status: 'A'`.
`GET /masters/projectActivities/*` aggregates these rows by `occurredAt` and
omits total keys whose sum is zero. Org usage is scoped to projects the caller
can access. Rows older than 730 days are soft-deleted (Phase 60).

## Bootstrap seed

On API startup the process ensures the default organization (`code: "DEFAULT_ORG"`),
one admin role (`code: "ADMIN"`, every catalog permission), and the admin user
(password hashed from the named constant `DEFAULT_ADMIN_PASSWORD`, `userStatus: 'active'`,
`code: "ADMIN"`) exist (ADR 0011, ADR 0032). Defaults are named constants — not env vars.
Worker processes do not seed.
