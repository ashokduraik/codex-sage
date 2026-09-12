# Phase 32 — Repository sync scheduler & sync job

- **Layer:** BE
- **Depends on:** Phase 29 (source diff, re-ingest semantics), Phase 31 (connection +
  encrypted credentials), Phase 21 (worker claim, `scheduledAt`, writer lock), Phases 25–28
  (ingest pipeline)
- **Unblocks:** Phase 58 (sync completed/failed notifications)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §21 (repository updates), §110 (external
  service failure), §111–§112 (import/readiness), §14–§16 (path exclusion on extract),
  §12–§13 (versioning); `backend/solution.md` §4.8B (Git sync every 30 minutes), §7 (jobs),
  §9.2 (audit sync trigger); `docs/architecture.md` §5 (ingest), §7 (indexing vs chat), §9
  (Worker → GitHub/GitLab)

## 1. Goal

After this phase a connected repository **stays current without user action**. A worker handler
`repo_sync` runs on a **30-minute** schedule per active connection (and on manual trigger):
decrypt credentials in memory, fetch the selected branch, compare commit SHA, and either
complete as “no changes” or create a new `SourceVersion`, write accepted bytes to GridFS,
and enqueue the existing **`ingest`** job that runs stages S0–S6 from Phases 25–28. Auth or
network failure **before** any graph mutation leaves **current Q&A usable** and updates
`connectionStatus` only.

You can see it working by attaching in Phase 31, calling `POST .../repositories/sync`, watching
a `repo_sync` job move to `completed`, then a child `ingest` job run through S0 with
`origin: 'github' | 'gitlab'`; repeating sync with the same SHA completes immediately with a
user-language “No changes” event. A bad token fails `repo_sync` with `connectionStatus`
`authentication_required` while `knowledgeHealth` stays whatever it was.

## 2. Why this phase is here

Phase 31 stores *that* we can read a repo and *which* branch — not the tree. Requirements §21
and solution §4.8B require periodic GitHub/GitLab updates, diff-aware knowledge refresh, and
safe behaviour when Git is down (backend §110).

It must follow Phase 29 so version N+1 reuses path+sha256 diff and skip lists into S3/S4.
It must follow Phase 31 for credentials and connection metadata. It cannot run before the
ingest pipeline is real (Phases 25–28) or sync would enqueue work with nowhere to go.

Scheduled ticks use Phase 21’s generic `scheduledAt` claim path; this phase adds the
**`repo_sync` job type**, the scheduler hook, and the download → GridFS → ingest bridge only.

## 3. Scope

### In scope

- Worker handler registration: `jobType: 'repo_sync'`.
- **Scheduler:** for each active `RepositoryConnection`, ensure a pending/running sync is not
  duplicated; enqueue due work every **`REPO_SYNC_INTERVAL_MS`** (30 minutes — named constant;
  per-project override deferred unless product asks).
- **Manual sync:** `POST .../repositories/sync` enqueues the same job immediately;
  **`Idempotency-Key`** required (Phase 12).
- **Download path (implementation TBD):** git fetch/pull **or** provider API archive — §12;
  must apply Phase 23 exclusion engine while iterating paths (backend §14, §10).
- **Same SHA:** no new `SourceVersion`, job `completed`, `JobEvent` “No changes on {branch}”.
- **New SHA:** insert `SourceVersion` with `origin: 'github' | 'gitlab'`, `commitSha`, branch,
  actor `system` or triggering user for manual sync; stream accepted files to GridFS like Phase 24;
  `createPendingJob({ jobType: 'ingest', ... })`; project lifecycle into `processing` / later
  worker paths (Phase 28 publish).
- **Overlap:** if a writer lock or an active `ingest` / `repo_sync` / knowledge job holds the
  project, defer sync (`scheduledAt` bump + event) — solution §4.8B, architecture §7.
- **Failure before graph mutation:** auth, network, provider 5xx during fetch only → fail
  `repo_sync`, set `connectionStatus` / reason code, **do not** call `transitionLifecycle` to
  `updating`, **do not** disable Q&A (architecture §5, §7).
- **Failure after source accepted:** ingest/recovery rules from Phases 28–29 apply; out of scope
  to re-specify here except that sync must not bypass writer lock or Q&A gate.
- **Branch change** (Phase 31 patch): next sync treats as full tree → new version; diff vs last
  **successful** ready version still applies (Phase 29).
- Audit: manual sync trigger (solution §9.2); job completion/failure events already via jobs module.
- Update connection fields: `lastSyncedCommitSha`, `lastSyncedAt`, `nextDueAt`, sync error metadata.

### Out of scope (owner phase)

- Probe and attach — **Phases 30–31**.
- Frontend sync button / schedule display — **Phases 34, 36, 35** (job progress).
- Notifications on sync complete — **Phase 58**.
- Choosing git vs archive permanently — **§12** (handler must isolate behind one adapter).
- Per-project sync interval settings UI — later (solution §4.8 table).
- In-app rate limiting — **not in this slice**.

## 4. Design

### 4.1 Job types and chaining

```text
Scheduler tick (21) or POST /repositories/sync
    → insert Job { jobType: 'repo_sync', scheduledAt, projectId, connectionId }
Worker claims repo_sync
    → repoSync.handler
         load connection + decrypt token (memory only)
         fetchRemoteTree(adapter)     ← git OR archive (§12)
         if auth/network fail BEFORE bytes persisted → fail job, update connectionStatus, STOP
         if commitSha == connection.lastSyncedCommitSha → complete, STOP
         else create SourceVersion + GridFS (Phase 24 patterns)
         enqueue ingest Job (pending)
         set lastSyncedCommitSha, lastSyncedAt, nextDueAt = now + REPO_SYNC_INTERVAL_MS
         complete repo_sync
Worker claims ingest (25–28) with IngestStageContext.origin = github|gitlab
```

`repo_sync` **does not** run S0–S6 itself; it only produces bytes and enqueues `ingest`, matching
architecture §5 (“API accepts… worker indexes” — here the worker’s first step is still fetch,
then the same ingest pipeline as upload).

### 4.2 Scheduler integration (Phase 21)

On worker startup and on a lightweight interval constant `REPO_SYNC_SCHEDULER_TICK_MS`, query
active connections (`status: 'A'`, `connectionStatus` not revoked) where
`nextDueAt <= now` (or `nextDueAt` null after attach — first run due immediately or after attach
policy in §12). For each candidate:

```text
if active project writer lock OR pending/running ingest|repo_sync on project:
    skip; leave nextDueAt unchanged OR bump by REPO_SYNC_OVERLAP_RETRY_MS (§12)
else if no pending repo_sync already queued for this connectionId:
    createPendingJob(repo_sync)
```

Attach in Phase 31 may set `nextDueAt = now` so the first sync happens without waiting 30 minutes
(**open question** in §12).

### 4.3 Remote fetch adapter

Single internal interface — **do not pick implementation in this document:**

```text
fetchRepositoryArchive({ provider, baseUrl, fullName, branch, token, signal })
  → { commitSha, commitMessage?, author?, entries: AsyncIterable<{ path, content, sha256 }> }
```

Implementations live under `modules/repositories/sync/` (e.g. `gitSyncAdapter.js`,
`archiveSyncAdapter.js`). Only one is wired at runtime once product chooses (§12). Shared rules:

- HTTPS / SSH URL resolution reuses Phase 30 `providerResolver`.
- Timeouts and size caps reuse `outboundHttp` patterns from Phase 30 where HTTP is used.
- Path filter: Phase 23 exclusion engine **during iteration** — skipped paths recorded on
  `SourceVersion` metadata counts (same as upload).
- Token only in memory and outbound headers; never logged.

### 4.4 SourceVersion and GridFS

Mirror Phase 24 semantics:

- New row per changed SHA (backend §12 versioning).
- `SourceFile` rows + GridFS bucket `GRIDFS_SOURCE_BUCKET`.
- Filename key `{orgId}/{projectId}/{sourceVersionId}/{path}`.
- Files > 1 MiB: store but `excludedFromGraph: true` (Phase 24 rule).

`IngestStageContext.origin` set from connection `provider` (`github` → `'github'`, GitLab SaaS
and self-hosted → `'gitlab'`) per Phase 25.

### 4.5 Diff and ingest handoff (Phase 29)

When a prior **successful** ready `SourceVersion` exists, compute diff summary (added/removed/changed/
unchanged) and attach to the new version or job payload so S3 can skip unchanged doc paths and S4
can prefer incremental sync. Exact persistence shape follows Phase 29’s decision — this phase
**consumes** it, does not fork a second diff algorithm.

### 4.6 Connection status vs project lifecycle

| Failure phase | `repo_sync` result | `connectionStatus` | Project `lifecycleStatus` / Q&A |
|---|---|---|---|
| Fetch/auth before bytes | `failed` | `authentication_required`, `unreachable`, … | unchanged; Q&A stays on |
| Same SHA | `completed` | `connected` | unchanged |
| New SHA, ingest running | `completed` | `connected` | → `processing` / `updating` via ingest (28) |
| Ingest/graph failure after accept | ingest/recovery (28) | may stay `connected` | Q&A off during rebuild per §7 |

### 4.7 Manual sync API handler

Fastify route owns `reply`. Service enqueues job, returns `202`. Does not download in the HTTP
process.

### 4.8 Idempotency

`POST /repositories/sync` with same `Idempotency-Key` returns the same `{ jobId }` without a
second concurrent `repo_sync` for that key scope. Distinct keys while one is running may return
`409 PROJECT_WRITER_BUSY` or enqueue with deferred `scheduledAt` — **§12**.

## 5. Data model changes

**`repositoryConnections`** (Phase 31) — additive fields:

```text
lastSyncedCommitSha: string | null
lastSyncedAt: Date | null
nextDueAt: Date | null
lastSyncJobId: ObjectId | null
lastSyncErrorCode: string | null
```

**`jobs`** — no schema change if Phase 20 already allows `jobType: 'repo_sync'`; payload
`metadata: { connectionId, trigger: 'scheduled' | 'manual', idempotencyKey? }`.

**`sourceVersions`** — ensure fields exist for `origin`, `commitSha`, `branch`, `repositoryConnectionId`
(if not already from Phase 24/29 — confirm before duplicate migration).

Index: `{ orgId, projectId, jobType, jobStatus }` already on jobs for overlap detection.

## 6. API contract — PROPOSED (needs approval before implementation)

### `POST /api/v1/projects/:projectId/repositories/sync`

- **Auth:** JWT. **Permission:** `repos.connect` (or `knowledge.trigger` — **§12**).
- **Idempotency-Key:** required.

Optional body:

```json
{ "reason": "manual" }
```

**Response `202`:**

```json
{
  "job": {
    "id": "job_01J...",
    "jobType": "repo_sync",
    "jobStatus": "pending",
    "scheduledAt": "2026-09-12T16:05:00.000Z"
  }
}
```

When sync is deferred due to writer busy, either `202` with later `scheduledAt` or `409
PROJECT_WRITER_BUSY` with `details.retryAfterSec` — pick at approval time (§12).

**Errors:** `401`, `403`, `404` (no connection), `409` idempotency / busy states.

### Internal worker contract (not HTTP)

```json
{
  "repoSyncResult": {
    "outcome": "no_changes | source_enqueued | failed",
    "commitSha": "abc123",
    "sourceVersionId": "src_01J...",
    "ingestJobId": "job_01J..."
  }
}
```

## 7. Configuration & environment variables

No new `.env` keys for interval (MVP uses named constants). Git binary path or workspace temp
directory may need env **only if** paths differ per environment — ask in §12 before adding.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `REPO_SYNC_INTERVAL_MS` | `1800000` (30 min) | `modules/repositories/sync/repoSync.scheduler.js` | Default cadence per connection |
| `REPO_SYNC_SCHEDULER_TICK_MS` | `60000` | same | How often worker scans due connections |
| `REPO_SYNC_OVERLAP_RETRY_MS` | `120000` | same | Defer when project writer busy |
| `REPO_SYNC_FETCH_TIMEOUT_MS` | `600000` | sync handler | Wall clock for fetch + extract |
| `REPO_SYNC_MAX_ARCHIVE_BYTES` | TBD with adapter | sync adapter | Cap download size |

Per-project interval override is **out of this phase** (solution §4.8 “configurable per project
later”).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/repositories/sync/repoSync.handler.js` (+ test) | **New:** worker entry |
| `backend/src/modules/repositories/sync/repoSync.service.js` (+ test) | **New:** orchestration, enqueue ingest |
| `backend/src/modules/repositories/sync/repoSync.scheduler.js` (+ test) | **New:** due connection scan |
| `backend/src/modules/repositories/sync/remoteFetch.port.js` | **New:** adapter interface |
| `backend/src/modules/repositories/sync/gitSyncAdapter.js` (+ test) | **New:** placeholder until §12 choice |
| `backend/src/modules/repositories/sync/archiveSyncAdapter.js` (+ test) | **New:** placeholder until §12 choice |
| `backend/src/modules/repositories/repositories.routes.js` (+ test) | **Extend:** `POST .../sync` |
| `backend/src/modules/repositories/repositoryConnection.model.js` | **Extend:** sync metadata fields |
| `backend/src/modules/sources/sources.repository.js` | Reuse/create SourceVersion + GridFS helpers |
| `backend/src/modules/jobs/jobs.repository.js` | Create `repo_sync` jobs, overlap queries |
| `backend/src/worker/index.js` | Register `repo_sync` handler + scheduler tick |
| `backend/src/modules/audit/audit.actions.js` | `repository.sync_triggered` |
| `backend/src/test/fixtures/repositories/` | **New:** small tree tarball/git mock for adapter tests |

## 9. Tests (≥ 80% line and branch)

Adapters mocked; no network in CI.

### Unit

- Same `commitSha` → no `SourceVersion`, outcome `no_changes`.
- New SHA → one `SourceVersion`, one `ingest` enqueue, diff hook invoked when prior version exists.
- Auth failure in adapter → job `failed`, `connectionStatus` updated, no `ingest` job, no lifecycle
  `updating`.
- Overlap: active writer → scheduler defers, no second lock breach.
- Token from decrypt appears nowhere in logs (scan like Phase 30).

### Integration (Mongo harness + mocked adapter)

- Manual sync route → `202`, job claimable, handler completes.
- Idempotent replay of sync POST → single active job per key.
- Full chain: `repo_sync` then mocked `ingest` handler receives correct `origin` and
  `sourceVersionId`.
- Cross-tenant connection id on job → handler aborts without writes.

### Unhappy paths

- Connection soft-deleted → sync route `404`.
- Fetch timeout → `failed`, retryability `temporary` per Phase 21 taxonomy.
- GridFS partial write → transaction abort, orphaned blob marking per Phase 24.

## 10. Definition of Done

- [ ] `repo_sync` registered; scheduler enqueues due work every `REPO_SYNC_INTERVAL_MS`.
- [ ] Manual `POST .../repositories/sync` enqueues same handler; `Idempotency-Key` honoured.
- [ ] Same commit SHA completes without new `SourceVersion` or ingest job.
- [ ] New SHA creates `SourceVersion`, GridFS bytes, and pending `ingest` using pipeline 25–28.
- [ ] Auth/network failure **before** persist leaves Q&A unchanged (test asserts no `updating`).
- [ ] Overlap skip when project writer active (no parallel syncs on same project).
- [ ] Credentials decrypted in memory only; never logged or returned.
- [ ] No in-app rate limiting added.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch on touched files.

## 11. Documentation & ADR updates

- `docs/architecture.md` §5: confirm Git sync bullet matches this job chain; §9 Worker →
  GitHub/GitLab row references `repo_sync`.
- `docs/data-model.md`: connection sync fields; `SourceVersion` repository metadata.
- ADR when git vs archive is chosen (§12) — supersede nothing until decision.

## 12. Risks & open questions

Ask the user; do not assume.

**From cross-cutting plan (Part G / open questions 9–11, 15):**

9. **Token scopes and probe→attach handoff** — sync uses stored credential; insufficient scope
   may fail at fetch time (surface as `access_denied` / `authentication_required`).
10. **Git fetch vs API archive** (solution §4.8) — which adapter is MVP?
11. **One repo connection per project vs many** — scheduler iterates connections; product rule
    affects uniqueness from Phase 31.
15. **Phase 30 leftover:** non-connected probe HTTP status, probe auditing, self-hosted TLS — if
    TLS custom trust is required, sync adapter must inherit it (not decided in Phase 30 §12).

**Sync-specific:**

16. **First sync timing** — immediately on attach vs wait full `REPO_SYNC_INTERVAL_MS`?
17. **Manual sync permission** — `repos.connect` only vs `knowledge.trigger`?
18. **Deferred sync response** — `202` with delayed job vs `409 PROJECT_WRITER_BUSY`?
19. **Temp clone directory** — git adapter needs `WORKSPACE_ROOT` subdir vs stream-only archive
    path (no on-disk full clone)?
20. **Nested GitLab groups** — clone URL shape for self-hosted (probe already resolves path).
21. **Scheduler placement** — worker-only tick vs API cron inserting jobs (must be worker-only
    per architecture).
22. **`repo_sync` job retention** — same job history rules as ingest (Phase 20).

**Carried from Phase 30 §12 (cited, not answered):** items 1–7 remain open for any re-probe or
status mapping shared with sync error surfaces.
