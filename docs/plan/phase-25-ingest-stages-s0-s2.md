# Phase 25 — Worker ingest stages S0–S2

- **Layer:** BE
- **Depends on:** Phase 21 (claim loop, heartbeat, lease sweeper, retry classification, handler
  registry), Phase 24 (GridFS bytes, `SourceVersion`, `SourceFile`, pending ingest job)
- **Unblocks:** Phase 26, 28, 29, 32
- **Size:** 1–2 days
- **Requirements covered:** backend §15, §16, §31–§34, §38, §39, §109; frontend §20, §21, §25;
  solution §4.1–§4.2, §4.6, §7; arch §5

## 1. Goal

After this phase the worker actually runs ingest work. A `pending` job of type `ingest` is
claimed by the worker (phase 21), dispatched to a new ingest handler, and executed as an ordered
stage pipeline whose first three stages exist: `S0 validate_upload`, `S1 store_files`,
`S2 exclude_apply` (solution §4.6). Each stage persists a checkpoint and writes a user-readable
`JobEvent`, so a worker crash mid-pipeline resumes at the last completed stage. You can see it
working by uploading a ZIP, watching `job.currentStage` advance and reading job events such as
`Source received` and `Exclusions applied (312 paths)`; killing the worker during S1 and
restarting it continues from the recorded file cursor rather than from the beginning.

## 2. Why this phase is here

Phase 24 stops at "bytes stored, `pending` job row exists"; phase 21 stops at "the worker can
claim a job and call a handler". Nothing joins the two, so no ingest runs. It must precede
phases 26–28 because every later stage needs the same frame — stage list, checkpoint, `JobEvent`
writer, honest counters, and the stage-context object carrying tenant scope — and building that
frame inside S3 or S4 means writing it twice. It cannot come earlier: the checkpoint has nowhere
to live until `Job` exists (phase 20) and nothing to resume until bytes exist (phase 24). Phase
32 reuses this handler with a repository origin, so the frame must not assume "upload".

## 3. Scope

### In scope

- Ingest handler registered with the phase 21 registry under job type `ingest`, plus the stage
  runner: resolve the resume point, run remaining stages, checkpoint after each, map thrown
  errors onto the phase 21 retry taxonomy.
- `S0 validate_upload`, `S1 store_files`, `S2 exclude_apply`, including orphan handling for
  partial GridFS writes, and the S0/S1/S2 rows of the solution §4.6 failure matrix.
- Per-file progress counters and partial-success accounting with explicit counts (backend §38,
  frontend §25), and the `IngestStageContext` object later stages receive.

### Out of scope (owner phase)

- `S3 materialize_docs` and document sections — **phase 26**; `S4 codegraph_update` and the
  graph writer lock — **phase 27**; `S5`, `S6`, `knowledgeHealth`, Q&A gate — **phase 28**.
- Source diff, retry and re-ingest intents — **phase 29**; repository origins — **phase 32**.
- HTTP upload validation and the exclusion rule set — **phase 23**.
- Job read APIs, progress endpoints, cancel and the generic retry route — **phases 20 and 22**.

## 4. Design

### 4.1 Handler and stage runner

```text
worker claim loop (21) → registry.get('ingest') → runIngestJob(job)
    resumeFrom = job.stageCheckpoint.lastCompletedStage
    for stage of INGEST_STAGES.after(resumeFrom):
      result = await stage.run(context)
      persist counters + checkpoint(lastCompletedStage = stage)
      emit JobEvent in user language, with real numbers
```

`INGEST_STAGES` is one ordered array — `validate_upload`, `store_files`, `exclude_apply`,
`materialize_docs`, `codegraph_update`, `knowledge_publish`, `finalize` (solution §4.6). This
phase implements the first three; the rest are placeholders that throw `NOT_IMPLEMENTED`, so the
ordering and checkpoint vocabulary are fixed once and later phases replace placeholders, never
the runner. Checkpointing is stage-granular plus an optional intra-stage cursor; a resumed job
never re-runs a completed stage (solution §4.6 hard rule 4), so stages must be idempotent when
re-entered from their cursor. Errors are classified `temporary`, `permanent` or
`user_action_required` before leaving the runner (backend §109, solution §4.6 hard rule 3); how
often to retry stays with the worker.

### 4.2 The stage-context object

Every stage receives exactly one argument. This is the contract later phases extend.

```text
IngestStageContext
├── scope      : { orgId, projectId, sourceVersionId, jobId, correlationId }
├── origin     : 'upload' | 'github' | 'gitlab'   ← phase 32 uses the repository values
├── attempt    : number     checkpoint : { lastCompletedStage, cursor? }
├── counters   : mutable IngestCounters (§4.4)
├── logger     : child logger bound to jobId + correlationId
├── signal     : AbortSignal, aborted on cancel or lost lease
├── emitEvent(kind, message, data?) → one JobEvent;  saveProgress() → flush counters + cursor
└── carry      : stage handoff (26 adds workspacePath, 27 adds graph identity)
```

`scope` comes from the claimed job row and is never re-derived from user input inside a stage,
so tenant isolation is decided once at the boundary (backend §89).

### 4.3 S0, S1, S2

**S0 `validate_upload`** re-validates what the worker is about to trust, because this is a
different process minutes after the upload: the `SourceVersion` exists, is `status: 'A'` and
belongs to the job's organization and project; its ingest state is the pending one written by
phase 24; the accepted set is non-empty after exclusions (empty once `node_modules` and images
are removed is `user_action_required` asking for a cleaner upload — solution §4.2, backend §15);
and every path is relative, normalised and inside the version, with no `..`, absolute prefix or
symlink escape (backend §16).

**S1 `store_files`** reconciles `SourceFile` rows against GridFS — object present, length equal,
`sha256` equal — ordered by path with the last reconciled path as the cursor, so a resumed S1
continues instead of rereading the tree. A row with no GridFS object becomes
`fileState: 'missing'` and a length or hash mismatch becomes `fileState: 'corrupt'`; both count
as failed files and the stage continues. A GridFS object with no row gets `orphanedAt` set —
marked, never hard-deleted, with the purge owned by phase 60. Above
`INGEST_MAX_FAILED_FILE_RATIO` the stage fails as `temporary` so the job can retry S1 from its
checkpoint; below it, the counts feed partial success.

**S2 `exclude_apply`** replays the phase 23 exclusion engine over the reconciled tree so
exclusions stay deterministic and visible (backend §14), recording one reason per file:
`ignored_path`, `image`, `unsupported_extension`, `over_graph_size_limit` (files over 1 MiB,
solution §4.1, backend §139) or `unsupported_language` (provisional here; phase 27 owns the
authoritative language list). The last two mean kept in GridFS but excluded from the graph; they
never fail the job, and phase 28 turns them into `partially_available`.

### 4.4 Counters, partial success and job events

`IngestCounters` holds `filesTotal`, `filesProcessed`, `filesFailed`, `filesExcluded`,
`bytesProcessed` and `excludedByReason` (one count per reason in §4.3). These are the only
source of the numbers the UI shows: nothing is estimated, smoothed or projected (backend §33),
and where an honest percentage is impossible the UI gets stage-based progress. `partialSuccess`
is true when `filesFailed > 0` and the job otherwise completed, and carries both counts so the
UI can render "4,812 processed successfully / 9 failed" (backend §38, frontend §25).

Each stage emits at least one `JobEvent` written for a non-engineer (backend §34, frontend §21):
`Source received`, `Source validated (N files)`, `Project files identified (N files, M failed)`
— the failed clause only when `M > 0` — and `Exclusions applied (N paths)`. Event text carries
no identifiers, stack traces or bytes; structured detail goes in the event `data` field that the
details view reads (frontend §26).

### 4.5 Failure matrix rows implemented here

| Stage | Job result | What is kept | Default recovery |
|---|---|---|---|
| S0 validate | `failed` immediately | Nothing usable for retrieval; version marked failed | Fix and re-upload; retry is not offered |
| S1 store_files | `failed` above the threshold, otherwise continues | Reconciled rows; partial GridFS objects marked orphaned | Retry S1 from checkpoint, or discard the version and re-upload |
| S2 exclusion | Never fails on excluded files | Excluded bytes stay in GridFS | Continue; phase 28 publishes `partially_available` |
| Worker crash | Sweeper (21) requeues or fails the job | Checkpoint, cursor, counters | Automatic reclaim, resume from last completed stage |

A failed job is never removed (solution §4.6 hard rule 1, backend §36).

## 5. Data model changes

Additive only; no new collection. Fields and indexes are declared on the Mongoose schemas and
synced via Phase 03 `syncSchemaIndexes`.

**`jobs`** — **owned by Phase 20.** This phase does not add `currentStage`, `stageCheckpoint`,
`progressCounters` or `partialSuccess`. It only writes those fields through the Phase 21
runtime helpers.

**`sourceFiles`** (phase 24) gains `fileState: 'stored' | 'missing' | 'corrupt'` (domain
lifecycle, distinct from row `status`), `exclusionReason: string | null`,
`excludedFromGraph: boolean` and `orphanedAt: Date | null` — only if Phase 24 did not already
add them. Confirm against Phase 24's schema before a second schema edit.

Row visibility stays `status: 'A' | 'D'` on both; nothing here hard-deletes. Indexes:
`{ orgId, projectId, sourceVersionId, path }` on `sourceFiles` filtered to
`status: 'A'`, and `{ orgId, projectId, jobStatus, currentStage }` on `jobs`.

## 6. API contract — PROPOSED (needs approval before implementation)

**This phase adds no HTTP surface** — it runs entirely in the worker. Job read and control
endpoints belong to phases 20 and 22 and only observe the fields above. The contract defined
here is the internal stage contract that phases 26, 27, 28 and 32 implement against.

```json
{
  "stage": { "name": "store_files", "run": "(ctx: IngestStageContext) => Promise<StageResult>" },
  "stageResult": {
    "outcome": "completed | completed_with_warnings",
    "cursor": null,
    "warnings": [{ "code": "SOURCE_FILE_MISSING", "path": "src/a.js" }]
  },
  "stageFailure": {
    "code": "SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS",
    "retryability": "user_action_required | temporary | permanent",
    "message": "No usable files remain after exclusions.",
    "details": { "excludedPaths": 4821 }
  },
  "jobEvent": {
    "jobId": "job_01J...",
    "stage": "exclude_apply",
    "kind": "stage_completed",
    "message": "Exclusions applied (312 paths)",
    "data": { "excludedPaths": 312, "filesProcessed": 4812, "filesFailed": 9 }
  }
}
```

## 7. Configuration & environment variables

**None.** No new `.env` keys. Batch size, flush interval, failed-file ratio, and stage timeout
are named constants in the ingest module (`.cursor/rules/env-config.mdc`).

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `INGEST_FILE_BATCH_SIZE` | `250` | `modules/ingest/ingest.counters.js` | Files reconciled per batch before a progress flush |
| `INGEST_PROGRESS_FLUSH_MS` | `2000` | `modules/ingest/ingest.counters.js` | Minimum interval between counter writes |
| `INGEST_MAX_FAILED_FILE_RATIO` | `0.05` | `modules/ingest/stages/s1StoreFiles.js` | Above this share of failed files S1 fails instead of continuing partially |
| `INGEST_STAGE_TIMEOUT_MS` | `900000` | `modules/ingest/ingest.handler.js` | Per-stage wall-clock budget before aborting as `temporary` |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/ingest/index.js` | **New:** public surface (`registerIngestHandler`, stage types) |
| `backend/src/modules/ingest/ingest.handler.js` (+ `.test.js`) | **New:** handler entry, full stage run over fixtures |
| `backend/src/modules/ingest/ingest.stages.js` (+ `.test.js`) | **New:** ordered stage list, resume resolution, placeholders |
| `backend/src/modules/ingest/ingest.context.js` | **New:** `IngestStageContext` built from a claimed job |
| `backend/src/modules/ingest/ingest.counters.js` (+ `.test.js`) | **New:** counters, batch flush, partial-success derivation |
| `backend/src/modules/ingest/ingest.events.js` (+ `.test.js`) | **New:** user-readable `JobEvent` message builders |
| `backend/src/modules/ingest/stages/s0ValidateUpload.js` (+ `.test.js`) | **New:** stage S0 |
| `backend/src/modules/ingest/stages/s1StoreFiles.js` (+ `.test.js`) | **New:** stage S1, cursor resume, orphan marking |
| `backend/src/modules/ingest/stages/s2ExcludeApply.js` (+ `.test.js`) | **New:** stage S2 |
| `backend/src/modules/ingest/ingest.repository.js` | **New:** tenant-scoped reads/writes for jobs, source files, events |
| `backend/src/worker/index.js` | Register the ingest handler with the phase 21 registry |
| `backend/src/modules/sources/sourceFile.model.js` | **Change if needed:** additive fields/indexes from §5 |
| `backend/src/test/fixtures/ingest/` | **New:** small tree, tree with excluded paths, tree with a file over 1 MiB |

## 9. Tests (≥ 80% line and branch)

### Unit

- The stage list resumes after `lastCompletedStage`; an unknown value fails loudly rather than
  silently restarting at S0; a placeholder stage throws `NOT_IMPLEMENTED` as `permanent`.
- Counters flush at most once per `INGEST_PROGRESS_FLUSH_MS` and always on stage boundaries.
- `partialSuccess` is true only when `filesFailed > 0` and the job otherwise completed.
- Event messages match §4.4, including the omitted failed clause when `M = 0`.
- Every stage failure carries a code and a retryability class; none returns a bare `Error`.

### Integration (Mongo harness from phase 03, GridFS fixtures)

- A fixture upload runs S0→S2 and leaves the expected counters, checkpoint and four job events.
- Aborting during S1 leaves a cursor; a second run reconciles only the remaining files.
- Re-running a completed stage creates no duplicate `SourceFile` rows or job events.
- A GridFS object with no `SourceFile` row is marked `orphanedAt` and its bytes still exist.

### Unhappy paths

- Tree empty after exclusions, and a path containing `..` or an absolute prefix → S0 fails with
  `user_action_required` and a path-safety code respectively.
- Job whose `orgId` differs from the source version → abort, nothing mutated.
- One hash mismatch → counted failed, job continues, partial success recorded; failed ratio
  above `INGEST_MAX_FAILED_FILE_RATIO` → S1 fails as `temporary`.
- Aborted `signal` mid-batch → stage stops, cursor persisted, no counters lost.

## 10. Definition of Done

- [ ] `ingest` is registered with the phase 21 registry and runs on claim.
- [ ] S0, S1 and S2 run in order, each persisting a checkpoint and at least one `JobEvent`.
- [ ] Restarting the worker mid-pipeline resumes at the last completed stage, proven by test.
- [ ] Event messages are in user language, with no identifiers or stack traces.
- [ ] Counters reflect only work performed; no percentage is fabricated; partial success carries
      explicit succeeded and failed counts.
- [ ] Orphaned GridFS objects are marked, never hard-deleted.
- [ ] Every failure carries a code plus a phase 21 retryability class.
- [ ] Additive `sourceFiles` fields (if not already on Phase 24) ship on the schema in one
      change; Job fields are not re-declared. Row `status` semantics unchanged.
- [ ] No new `.env` keys. Ingest batch, flush, ratio, and timeout are constants.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/architecture.md` §5: confirm the S0–S6 list matches `INGEST_STAGES` exactly; correct the
  document if implemented names differ.
- No new ADR expected. If the failed-file threshold is challenged in review, record it as an ADR
  rather than arguing in the pull request.
- `backend/solution.md` §4.6 stays authoritative; update only if this phase contradicts it.

## 12. Risks & open questions

1. **Field ownership overlap.** **Decided.** Phase 20 owns `currentStage`, `stageCheckpoint`
   and `progressCounters` on `Job`. Do not add a second schema pass for those fields.
2. **Failed-file threshold:** is 5% the right boundary between partial success and stage
   failure, or should any failed file fail the ingest?
3. **S1 responsibility.** **Decided.** Phase 24 writes accepted bytes during the request.
   S1 is reconciliation (missing/corrupt vs GridFS), not a second full write.
4. **Event granularity:** should the runner also emit a "stage started" event, doubling the
   event count the frontend checklist (frontend §20) consumes?
5. **Exclusion replay:** if the rule set changed between upload and worker run, must S2 use the
   rules recorded on the `SourceVersion` or the current ones?
6. **Cancellation:** phase 22 owns cancel. Should a cancelled job keep its checkpoint for later
   resume, or discard it?
