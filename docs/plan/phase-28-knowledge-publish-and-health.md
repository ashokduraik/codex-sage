# Phase 28 — Knowledge publish, health, recovery & Q&A gate

- **Layer:** BE (+ small FE enum rename)
- **Depends on:** Phase 27 (validated graph identity on S4 checkpoint cursor, S4 complete)
- **Unblocks:** Phase 29, 36, 37, 38, 51, 58
- **Size:** 1–2 days
- **Requirements covered:** backend §26–30, §85, §93–94, §111–112, §144; backend/solution.md §4.3
  step 5, §4.6 (S5–S6, recovery narrative), §9.2; docs/architecture.md §5 (S5–S6), §7

## 1. Goal

After this phase **S5 `knowledge_publish`** and **S6 `finalize`** replace their placeholders. The
worker inserts a `KnowledgeVersion` linked to the job’s `sourceVersionId`, sets project
`knowledgeHealth` and `lifecycleStatus` only through `transitionLifecycle` with `source: 'worker'`
(and `knowledgeVersionId` when entering `knowledge_ready` / `partially_available`), emits audit
events for knowledge completed/failed, and exports an internal **Q&A gate** so chat/search (later
phases) refuse mutating or unpublished graphs.

When S4 fails with attempts remaining, recovery stays **in the same ingest job**: rematerialize
**this job’s** source tree, full `indexAll`, validate, then S5. Exhaustion marks knowledge failed.
You can see it working when an ingest completes through S6, the project shows `ready` or
`partially_available` (not via HTTP forgery), and a simulated S4 failure either recovers and
publishes or fails with structured codes.

## 2. Why this phase is here

Phases 25–27 produce bytes, sections, and a validated index artifact, but the product’s
authoritative “what is current knowledge?” state lives in `KnowledgeVersion` + project health
(backend §26, §29, §85). Phase 17 forbids HTTP from reaching `knowledge_ready` /
`partially_available`; only the worker may publish. Chat concurrency rules (§93–94, §144) require
a single gate before phases 50/51 accept streams. Recovery in solution §4.6 spans S4–S5; this
phase owns the orchestration that re-invokes S3/S4 helpers without a second ingest runner.

It cannot come earlier: S4 must stash `graphIdentity` on the checkpoint cursor. It cannot come
later: phase 29 diffs against the last published version, and phases 36/37/51 read health and the
gate.

## 3. Scope

### In scope

- Rename project `knowledgeHealth` **`partial` → `partially_available`** (schema, GET `/projects`,
  frontend badge map / `isProjectAskable` / i18n). Same string as lifecycle. Breaking for any
  client still sending or expecting `partial`.
- S5 `knowledge_publish`: insert `KnowledgeVersion`; persist S4 `graphIdentity` (no absolute
  paths); count `excludedFromGraph`; published health `ready` | `partially_available`.
- S6 `finalize`: **do not** call `finishJobCompleted` (worker runtime already terminals the job
  from the handler return). `transitionLifecycle` to `knowledge_ready` | `partially_available`;
  write `currentKnowledgeVersionId` and `knowledgeHealth`.
- Job-start lifecycle (after project lock, before S0): `source_received` → `processing`; already
  published → `updating` + health `updating`.
- Partial publish: any stored `SourceFile` with `excludedFromGraph: true` forces
  `partially_available` and job `completed_with_warnings`.
- Internal gate `assertKnowledgeReadable({ orgId, projectId })` → allow | queue | deny.
- Same-job S4 recovery: rematerialize **this job’s** `sourceVersionId`, wipe `.codegraph`,
  `indexAll`, validate, then continue to S5. Bounded attempts on the checkpoint cursor.
- Terminal ingest failure: `runIngestJob` uses `decideFailureOutcome`; on `fail`, transition
  project to `failed` + `knowledgeHealth: failed` (pointer unchanged), audit `knowledge.failed`.
- Audit `knowledge.completed` / `knowledge.failed` (ids and counts only).
- User-language JobEvents: `Project knowledge updated`, `Knowledge validated`, `Ready`.
- Replace S5/S6 placeholders in `INGEST_STAGES`.
- Register `KNOWLEDGE_MODELS` (and `PROJECT_MODELS` on the worker) for index sync.

### Out of scope (owner phase)

- Queued chat messages and `202` SSE — **phase 51** (gate returns reason only).
- Browse/search HTTP, including `GET …/knowledge/health` — **phases 37–38**.
- Notifications on publish — **phase 58**.
- Retention/purge of old `KnowledgeVersion` / `SourceVersion` rows — **phase 60**.
- Source diff and `reingest` API — **phase 29**.
- Writing `stale` health — later (phase 29/32). This phase never sets `stale`.
- Git-fail-before-mutation leaving Q&A on — **phase 32**.
- LangGraph or LLM calls.
- New env vars.

## 4. Design

Locked product decisions are in **§12**. Do not re-open them.

### 4.1 Health and lifecycle mapping

One vocabulary on both fields for the partial state:

| Publish outcome | `KnowledgeVersion.publishedHealth` | `project.knowledgeHealth` | `project.lifecycleStatus` | Job result |
|---|---|---|---|---|
| Full coverage | `ready` | `ready` | `knowledge_ready` | `completed` |
| Any `excludedFromGraph` | `partially_available` | `partially_available` | `partially_available` | `completed_with_warnings` |
| S5 error / recovery exhausted | (no new current row, or unused failed row) | `failed` | `failed` | `failed` |

`knowledgeHealth` enum after rename:

```text
none | updating | ready | partially_available | stale | failed
```

`stale` remains in the enum and is unused here. Frontend `isProjectAskable` is true when
`knowledgeHealth` is `ready` or `partially_available` and the project is not archived.

`assertKnowledgeHealthAllowed`: `ready` **and** `partially_available` are illegal while lifecycle
is `creating | awaiting_source | connecting_repository | source_received`.

### 4.2 Job-start lifecycle (`runIngestJob`, after lock, before S0)

Today upload only moves `awaiting_source` → `source_received`. The phase 17 table forbids
`source_received` → `knowledge_ready`, so this phase must enter `processing` / `updating`.

| Current lifecycle | Transition (`source: 'worker'`, no `knowledgeVersionId`) |
|---|---|
| `source_received` | → `processing`; health stays `none` |
| `knowledge_ready` or `partially_available` | → `updating`; health → `updating` |
| `failed` with `currentKnowledgeVersionId` | → `updating`; health → `updating` |
| `failed` without a pointer | → `processing`; health stays `failed` (gate keeps denying) |
| `processing` / `updating` | no-op (resume) |

Q&A turns off for a re-run because health becomes `updating` **and** the job holds
`project_writer`. First ingest has no `currentKnowledgeVersionId` → gate **deny**, not queue.
Git-fail-before-mutation (Q&A stays on) is phase 32.

### 4.3 Publish pipeline (S5 → S6)

`carry` is rebuilt empty on every job attempt. S5 **must** read identity from
`ctx.checkpoint.cursor.graphIdentity` (S4 already writes it), falling back to `ctx.carry`.

```text
S5 knowledge_publish(ctx)
  identity = checkpoint.cursor.graphIdentity ?? carry.graphIdentity
  if missing → permanent INGEST_MISSING_GRAPH_IDENTITY

  excludedFileCount = count SourceFile {
    orgId, projectId, sourceVersionId, status A, stored, excludedFromGraph true
  }
  publishedHealth = excludedFileCount > 0 ? partially_available : ready

  reuse existing KnowledgeVersion for { orgId, projectId, sourceVersionId, status A }
    when graphHash matches (idempotent resume)
  else insert KnowledgeVersion { … publishedHealth, excludedFileCount, publishedAt, status A,
    createdBy/updatedBy null,
    graphIdentity: {
      graphHash, indexedAt, sourceVersionId,
      indexedFileCount, skippedFileCount, mode,
      graphDir: '.codegraph'          // never persist an absolute workspace path
    }
  }

  carry.knowledgeVersionId / publishedHealth / excludedFileCount = …
  audit knowledge.completed { sourceVersionId, knowledgeVersionId, publishedHealth, excludedFileCount }
  JobEvents: knowledge.updated, knowledge.validated
  return completed | completed_with_warnings

S6 finalize(ctx)
  require carry.knowledgeVersionId and publishedHealth
  from = project.lifecycleStatus          // processing | updating
  to = publishedHealth === 'ready' ? knowledge_ready : partially_available
  transitionLifecycle({
    source: 'worker',
    knowledgeVersionId,
    knowledgeHealth: publishedHealth,     // NEW field on the transition
    from, to
  })
  JobEvent knowledge.ready → "Ready"
  return the S5 outcome (handler ORs in filesFailed / filesExcluded)
```

`transitionLifecycle` / `conditionalLifecycleUpdate` must `$set` `knowledgeHealth` when provided.
They do **not** today.

S6 never calls `finishJobCompleted` / `finishJobFailed`. `runIngestJob` returns
`{ result, summary }`; `workerRuntime` terminals the job.

`derivePartialSuccess` (or the handler return) must treat `filesExcluded > 0` as
`completed_with_warnings`, not only `filesFailed`.

### 4.4 Q&A gate (internal)

```text
assertKnowledgeReadable({ orgId, projectId })
  load project status A; missing → deny (callers map to NOT_FOUND)
  if archived → deny KNOWLEDGE_UNAVAILABLE
  if knowledgeHealth === 'failed' → deny KNOWLEDGE_UNAVAILABLE
  if !currentKnowledgeVersionId → deny KNOWLEDGE_UNAVAILABLE
  if knowledgeHealth === 'updating' → queue KNOWLEDGE_UPDATING
  if hasActiveProjectWriterLock(orgId, projectId) → queue KNOWLEDGE_UPDATING
  if knowledgeHealth in { ready, partially_available }
     and lifecycleStatus in { knowledge_ready, partially_available }
     → allow { knowledgeVersionId }
  else → deny KNOWLEDGE_UNAVAILABLE
```

Gate does **not** take a CodeGraph read lease. Phases 37/46 acquire the lease after `allow`.

Add `hasActiveProjectWriterLock` on `backend/src/worker/projectJobLock.js` (live
`project_job_locks` row, `status: 'A'`, `expiresAt` in the future / server `$$NOW`).

Error catalog:

- Add `KNOWLEDGE_UPDATING` (class `knowledge`, HTTP 503, retryability `temporary`, message
  `Project knowledge is being updated.`).
- Change `KNOWLEDGE_UNAVAILABLE` message to `Project knowledge is not available.` (today it
  incorrectly says “being updated”).

No HTTP route in this phase. `GET /projects/:id` already returns health, pointer, and lifecycle.

### 4.5 Recovery (same job)

On S4 classified **temporary** CodeGraph failure, before the error leaves the ingest handler:

```text
attempts = checkpoint.cursor.recoveryAttempts ?? 0
if attempts >= KNOWLEDGE_RECOVERY_MAX_ATTEMPTS (3):
  throw permanent CODEGRAPH_RECOVERY_EXHAUSTED

save cursor.recoveryAttempts = attempts + 1
runMaterializeDocsStage(ctx)     // this job’s sourceVersionId — not last published
delete workspace .codegraph      // next S4 takes indexAll, not a broken sync
runCodegraphUpdateStage(ctx)
continue pipeline to S5
```

Call existing S3/S4 stage functions. No new job type. No second ingest runner.

### 4.6 Terminal failure

`finishJobFailed` has no ingest hook. In `runIngestJob` `catch`:

```text
decision = decideFailureOutcome({ failure, attempt: job.attempt, maxAttempts })
if decision.action === 'fail':
  transitionLifecycle to failed (from processing | updating)
  knowledgeHealth → failed; currentKnowledgeVersionId unchanged
  audit knowledge.failed { code, sourceVersionId }   // no secrets, no paths
rethrow
```

Temporary requeues leave `processing` / `updating` so the gate stays off.

### 4.7 Prior KnowledgeVersion rows

Keep old rows `status: 'A'`. Only `project.currentKnowledgeVersionId` moves. Queryable current
knowledge is the pointer. Soft-delete / purge is phase 60.

### 4.8 Failure matrix

| Failure | Job | Project lifecycle / health | Gate |
|---|---|---|---|
| Temporary S4/S5, attempts remain | requeue | stays `processing` or `updating` | queue or deny (no pointer) |
| S5 publish error, last attempt | `failed` | `failed` / `failed` | deny |
| S4 recovery exhausted | `failed` | `failed` / `failed` | deny `KNOWLEDGE_UNAVAILABLE` |
| Exclusions, S5/S6 ok | `completed_with_warnings` | `partially_available` / `partially_available` | allow after S6 |
| Full coverage | `completed` | `knowledge_ready` / `ready` | allow after S6 |

Failed jobs remain readable (phase 25).

## 5. Data model changes

### `knowledgeVersions` (new collection)

| Field | Notes |
|---|---|
| Base | `orgId`, `projectId`, `status: 'A' \| 'D'`, timestamps, `createdBy` / `updatedBy` (null for worker) |
| `sourceVersionId` | ObjectId |
| `graphIdentity` | Subdocument: `graphHash`, `indexedAt`, `sourceVersionId`, `indexedFileCount`, `skippedFileCount`, `mode`, `graphDir` (`.codegraph` only — no absolute path) |
| `publishedHealth` | `ready` \| `partially_available` \| `failed` |
| `excludedFileCount` | number ≥ 0 |
| `publishedAt` | UTC Date |

Indexes (partial `status: 'A'`):

- `{ orgId, projectId, publishedAt: -1, _id: -1 }` — current/history list.
- `{ orgId, projectId, sourceVersionId }` — lookup / idempotent resume.

### `projects`

No new fields. This phase:

- Renames `knowledgeHealth` enum value `partial` → `partially_available`.
- Writes `currentKnowledgeVersionId`, `knowledgeHealth`, and `lifecycleStatus` **only** via
  `transitionLifecycle`.

### `jobs`

No new schema fields. Recovery attempt count lives on `stageCheckpoint.cursor.recoveryAttempts`
(phase 21 `saveCheckpoint`).

## 6. API contract — APPROVED (internal only)

**No user-facing HTTP in this phase.** Optional `GET /projects/:projectId/knowledge/health` is
rejected; project GET already returns the three fields. Browse health is phase 37.

Internal gate (exported from `modules/knowledge`):

```json
{
  "assertKnowledgeReadable": {
    "input": { "orgId": "…", "projectId": "…" },
    "output": {
      "action": "allow | queue | deny",
      "knowledgeVersionId": "… or omitted",
      "code": "KNOWLEDGE_UPDATING | KNOWLEDGE_UNAVAILABLE",
      "message": "catalog message for code"
    }
  }
}
```

## 7. Configuration & environment variables

**None.**

### Constants (not env)

| Constant | Home | Value / purpose |
|---|---|---|
| `KNOWLEDGE_RECOVERY_MAX_ATTEMPTS` | `modules/knowledge/knowledge.recovery.js` | `3` — S4 rebuild tries before failed |
| Stage wall clock | reuse `INGEST_STAGE_TIMEOUT_MS` | Do not add a second S5 timeout unless a split is required |

Queue expiry remains phase 51 / evaluation.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/knowledge/index.js` | **New:** public surface + `KNOWLEDGE_MODELS` |
| `backend/src/modules/knowledge/knowledgeVersion.model.js` | **New:** schema + indexes |
| `backend/src/modules/knowledge/knowledgeVersion.repository.js` (+ `.test.js`) | **New:** tenant-scoped insert/find |
| `backend/src/modules/knowledge/knowledge.publish.js` (+ `.test.js`) | **New:** S5 domain logic |
| `backend/src/modules/knowledge/knowledge.recovery.js` (+ `.test.js`) | **New:** rematerialize + S4 retry |
| `backend/src/modules/knowledge/knowledge.gate.js` (+ `.test.js`) | **New:** `assertKnowledgeReadable` |
| `backend/src/modules/ingest/stages/s5KnowledgePublish.js` (+ `.test.js`) | **New:** thin S5 stage |
| `backend/src/modules/ingest/stages/s6Finalize.js` (+ `.test.js`) | **New:** thin S6 stage |
| `backend/src/modules/ingest/ingest.stages.js` | Wire S5/S6 |
| `backend/src/modules/ingest/ingest.handler.js` | Job-start lifecycle; fail hook; warnings include exclusions |
| `backend/src/modules/ingest/ingest.counters.js` | `derivePartialSuccess` treats exclusions as warnings |
| `backend/src/modules/ingest/ingest.events.js` | S5/S6 event builders |
| `backend/src/modules/jobs/jobEventCatalog.js` | `knowledge.validated`, `knowledge.ready` |
| `backend/src/modules/projects/projects.model.js` | Enum rename `partial` → `partially_available` |
| `backend/src/modules/projects/projects.lifecycle.js` | Health invariant includes `partially_available` |
| `backend/src/modules/projects/projects.service.js` | Pass `knowledgeHealth` through `transitionLifecycle` |
| `backend/src/modules/projects/projects.repository.js` | `$set` `knowledgeHealth` on conditional update |
| `backend/src/worker/projectJobLock.js` | `hasActiveProjectWriterLock` |
| `backend/src/worker/index.js` | Sync `PROJECT_MODELS` + `KNOWLEDGE_MODELS` |
| `backend/src/index.js` | Sync `KNOWLEDGE_MODELS` |
| `backend/src/modules/audit/audit.actions.js` | `knowledge.completed` / `knowledge.failed`; resourceType `knowledge` |
| `backend/src/platform/errorCatalog.js` | `KNOWLEDGE_UPDATING`; fix `KNOWLEDGE_UNAVAILABLE` message |
| `frontend/src/features/projects/projectStatusMap.js` (+ `.test.js`) | Enum + `isProjectAskable` |
| `frontend/src/features/projects/api/projectTypes.js` | `KnowledgeHealth` typedef |
| `frontend/src/features/projects/buildMockProjectBridge.js` | Map `partially_available` |
| `frontend/src/features/projects/test/projectApiFixtures.js` | Fixtures |
| `frontend/src/shared/components/StatusBadge.test.jsx` | Badge for new code |
| `frontend/src/shared/i18n/locales/en.json` | `status.knowledgeHealth.partiallyAvailable` |
| `docs/data-model.md` | `knowledgeVersions` + renamed health enum |
| `docs/architecture.md` §7 | Q&A off at worker claim / `updating` + writer lock |

Do **not** change Processing Center `job.status === 'partial'` (job UI, not knowledge health).

## 9. Tests (≥ 80% line and branch)

### Unit

- Exclusions → `publishedHealth` `partially_available`, not `ready`.
- Missing graph identity → `permanent` `INGEST_MISSING_GRAPH_IDENTITY`.
- Gate: none / failed / no pointer / updating / writer lock / ready / `partially_available` /
  archived.
- `transitionLifecycle` rejects API source for `knowledge_ready` and `partially_available`.
- Health `partially_available` rejected in pre-knowledge lifecycle states.
- Recovery: S3 then S4 (mocked) in order; stops at max attempts with
  `CODEGRAPH_RECOVERY_EXHAUSTED`.
- Enum: `KNOWLEDGE_HEALTH_VALUES` contains `partially_available`, not `partial`.
- Frontend: `isProjectAskable` true for `partially_available`; legacy `'partial'` is not askable.

### Integration

- Full ingest S0–S6: `KnowledgeVersion` row, pointer, lifecycle + health, audit,
  JobEvents (`Project knowledge updated`, `Knowledge validated`, `Ready`).
- S4 fail → recovery success → publish → gate `allow`.
- Recovery exhaust → project `failed`; gate `deny` `KNOWLEDGE_UNAVAILABLE`.
- Resume after S4 checkpoint: empty `carry`, identity from cursor still publishes.
- Second ingest on a ready project: job start → `updating`; S6 returns to
  `knowledge_ready` or `partially_available`; prior KV remains `status: 'A'`.
- Cross-tenant publish: no writes.

### Unhappy paths

- Publish without graph identity → `permanent`.
- Cross-tenant scope → `TENANT_SCOPE_MISSING` / no row.
- Earlier-stage `filesFailed` plus clean graph → `completed_with_warnings`.

## 10. Definition of Done

- [ ] S5 and S6 replace placeholders; ingest completes end-to-end through S6.
- [ ] `knowledgeVersions` collection with `status: 'A'|'D'` and indexes synced in API + worker + tests.
- [ ] `knowledgeHealth` enum is `none|updating|ready|partially_available|stale|failed` in backend
      and frontend maps; no remaining product use of health code `partial`.
- [ ] Project health/lifecycle updated only via `transitionLifecycle`; HTTP still cannot reach
      `knowledge_ready` / `partially_available`.
- [ ] Job-start transitions enter `processing` or `updating` so S6 is a legal next state.
- [ ] Graph exclusions produce `partially_available`, not `ready`.
- [ ] Q&A gate exported for phases 50/51/37; no read lease inside the gate.
- [ ] Same-job recovery rematerializes **this** source version; exhausted → failed + audit.
- [ ] Audit `knowledge.completed` / `knowledge.failed` without secrets or absolute paths.
- [ ] Job terminal status only via phase 21 worker helpers (handler return / throw).
- [ ] `docs/data-model.md` and architecture §7 match the code.
- [ ] `npm run lint`, `npm test`; coverage ≥ 80% line and branch on new/changed modules.

## 11. Documentation & ADR updates

- `docs/data-model.md`: add `knowledgeVersions`; rename `knowledgeHealth` `partial` →
  `partially_available`; note current knowledge is the project pointer.
- `docs/architecture.md` §7: Q&A off when health is `updating` or a live `project_writer` lock
  exists; first ingest without a pointer is unavailable (not queued).
- `backend/solution.md` §4.6: recovery rematerializes **the failing job’s** accepted tree (not
  last published) via S3 + `indexAll` in the same job.
- No ADR: enum rename is aligning shipped schema to solution vocabulary; recovery is in-job as
  solution §4.6 already describes.

## 12. Risks & open questions — resolved

1. **knowledgeHealth naming (Q5).** Locked: rename `partial` → `partially_available` on
   `knowledgeHealth` (and `KnowledgeVersion.publishedHealth`). One vocabulary with lifecycle.
2. **When Q&A disables (Q6).** Locked: gate queues on `updating` **or** live `project_writer`;
   denies on `failed` / `none` / missing pointer; allows `ready` | `partially_available` with no
   writer. This phase sets `processing` / `updating` at ingest job start after lock acquire, not
   at HTTP upload. `stale` is not written. Git-fail-before-mutation is phase 32.
3. **Recovery job vs in-stage (Q7).** Locked: same ingest job. Rematerialize this job’s
   `sourceVersionId`, full `indexAll`, then S5. `KNOWLEDGE_RECOVERY_MAX_ATTEMPTS`. Exhausted →
   job + project failed, audit `knowledge.failed`. No new job type.
4. **`stale` health.** Locked for this phase: do not set it. Owner is a later source-change
   phase (29/32).
5. **Prior KnowledgeVersion rows.** Locked: keep `status: 'A'`; only the project pointer moves.
   Purge is phase 60.
6. **Gate vs read lease.** Locked: gate is policy only. Read lease stays on the CodeGraph
   adapter for phases 37/46.
7. **Lifecycle on first ingest.** Locked: `source_received` → `processing` at job start, then
   S6 `processing` → `knowledge_ready` | `partially_available` | `failed`.
8. **Health HTTP.** Locked: skip. Project GET is sufficient until phase 37.

### Implementation order

1. Enum rename (backend model + frontend maps).
2. `transitionLifecycle` writes `knowledgeHealth`; tighten invariants.
3. `KnowledgeVersion` model/repo + index sync on API and worker.
4. Audit actions, error catalog, job events.
5. `hasActiveProjectWriterLock` + gate.
6. Publish helper + S5.
7. Job-start transitions + S6.
8. Recovery wrapper + fail hook in `runIngestJob`.
9. Wire `INGEST_STAGES`; extend ingest integration tests through S6.
10. Docs listed in §11.
