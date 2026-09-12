# Phase 28 — Knowledge publish, health, recovery & Q&A gate

- **Layer:** BE
- **Depends on:** Phase 27 (validated graph identity on `carry`, S4 complete)
- **Unblocks:** Phase 29, 36, 37, 38, 51, 58
- **Size:** 1–2 days
- **Requirements covered:** backend §26–30, §85, §93–94, §111–112, §144; backend/solution.md §4.3
  step 5, §4.6 (S5–S6, recovery narrative), §9.2; docs/architecture.md §5 (S5–S6), §7

## 1. Goal

After this phase **S5 `knowledge_publish`** and **S6 `finalize`** replace their placeholders. The
worker inserts a `KnowledgeVersion` linked to the job’s `sourceVersionId`, sets project
`knowledgeHealth` and `lifecycleStatus` only through `transitionLifecycle` with `source: 'worker'` and
a `knowledgeVersionId`, emits audit events for knowledge completed/failed, and exposes an internal
**Q&A gate** so chat/search (later phases) refuse stale or mutating graphs. When S4 fails with
recovery exhausted, the worker can rematerialize the last successfully **published** source tree,
rebuild the graph, validate, and publish — or mark knowledge failed and leave queued messages for
phase 51. You can see it working when an ingest completes, the project shows ready or partial health
(not via HTTP forgery), and a simulated S4 failure followed by recovery republishes or fails with
structured codes.

## 2. Why this phase is here

Phases 25–27 produce bytes, sections, and a validated index artifact, but the product’s authoritative
“what is current knowledge?” state lives in `KnowledgeVersion` + project health (backend §26, §29,
§85). Phase 17 forbids HTTP from reaching `knowledge_ready` / `partially_available`; only the worker
may publish (phase 17 plan). Chat concurrency rules (§93–94, §144) require a single gate before
phase 50/51 accept streams. Recovery behavior in solution §4.6 spans S4–S5; this phase owns the
orchestration that re-invokes S3/S4 helpers without inventing a second ingest runner.

## 3. Scope

### In scope

- S5 `knowledge_publish`: create `KnowledgeVersion` row; link graph identity from `carry`; record
  exclusion summary; compute published health **`ready` | `partially_available` | `failed`** using
  solution/architecture vocabulary — **not** the data-model enum literals until mapping is decided
  (§12).
- S6 `finalize`: set job terminal status (`completed`, `completed_with_warnings`, `failed`); invoke
  `transitionLifecycle` for project states (`processing` → `knowledge_ready` | `partially_available`
  | `failed`, `updating` → same on re-ingest path); write `currentKnowledgeVersionId` on project.
- Partial publish: any `SourceFile` with `excludedFromGraph: true` prevents **`ready`**; must publish
  **`partially_available`** when otherwise successful (solution §4.6, backend §139, §112).
- **Q&A gate helper** `assertKnowledgeReadable(projectScope)` (or equivalent) used internally —
  returns allow | queued | unavailable with stable error codes for 50/51/37.
- **Recovery path** when S4 fails: rematerialize last published `sourceVersionId`, rerun S4 validation,
  then S5 — bounded attempts; exhausted → `failed` health, audit `knowledge.failed`.
- Audit: `knowledge.completed` / `knowledge.failed` per solution §9.2 (no secrets, counts/ids only).
- User-language events: `Knowledge updated`, `Knowledge validated`, `Ready` (backend §30).
- Replace S5/S6 placeholders in `INGEST_STAGES`.

### Out of scope (owner phase)

- Persisting queued chat messages and `202` SSE behavior — **phase 51** (gate returns reason only).
- Browse/search HTTP — **phases 37–38**; notifications on publish — **phase 58**.
- Retention/purge of old `KnowledgeVersion` / `SourceVersion` rows — **phase 60**.
- Source diff and `reingest` API — **phase 29**.
- LangGraph or LLM calls.

## 4. Design

### 4.1 Publish pipeline (S5 → S6)

```text
S5 knowledge_publish(context)
  validation = require S4 carry.graphIdentity + successful validate snapshot
  exclusions = count SourceFiles excludedFromGraph for sourceVersionId
  health = exclusions > 0 ? 'partially_available' : 'ready'   ← solution terms; persist mapping §12

  insert KnowledgeVersion { sourceVersionId, graphIdentity, health, publishedAt, status: 'A' }
  soft-delete prior "current" pointer semantics: project.currentKnowledgeVersionId = new id
  audit knowledge.completed (counts, version ids)

  return completed | completed_with_warnings

S6 finalize(context)
  set job terminal fields via phase 21 helpers
  transitionLifecycle({
    source: 'worker',
    knowledgeVersionId,
    lifecycleStatus: map from health + prior state
  })
  emit final JobEvent in user language
```

Failed S5 leaves project in **`failed`** or **`updating`** per prior state — exact matrix **§12**
for `stale` and data-model `partial` vs solution `partially_available`.

### 4.2 Q&A gate (internal)

```text
assertKnowledgeReadable({ orgId, projectId })
  load project (status A)
  if knowledgeHealth in { updating, recovering? } → { action: 'queue', code: 'KNOWLEDGE_UPDATING' }
  if knowledgeHealth failed → { action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' }
  if lifecycle not in { knowledge_ready, partially_available } → deny appropriately
  if project_job_locks holder active for project_writer → queue (graph mutation in flight)
  else if health ready | partially_available → { action: 'allow', knowledgeVersionId }
```

Exact moment Q&A turns off when a new ingest starts (**S3 vs S4 vs job claim**) is **cross-cutting
Q6** — gate must match product decision; do not implement a default in this plan.

### 4.3 Recovery (solution §4.6 example)

On S4 failure classified recoverable and attempts remain:

```text
within same job OR separate recovery job?  ← §12
  resolve lastPublishedSourceVersionId from KnowledgeVersion / project
  rebuild context.carry for that version
  call S3 rematerialize helper (26) for that version's bytes
  call S4 adapter (27)
  on success → S5 publish; resume queued questions (51)
  on exhaustion → health failed; fail queued with retryable KNOWLEDGE_UNAVAILABLE
```

Recovery must not leave chat reading a half-updated graph (architecture §7).

### 4.4 Lifecycle transitions (phase 17)

Only **`transitionLifecycle`** mutates `lifecycleStatus` and `knowledgeHealth` on `projects`.
HTTP routes remain unable to set `knowledge_ready` / `partially_available`.

Worker publishes require `knowledgeVersionId`. Mapping from `KnowledgeVersion.health` to project
`knowledgeHealth` column is **§12** (data-model `none|updating|ready|partial|stale|failed` vs
solution `ready|partially_available|failed`).

### 4.5 Failure matrix rows (S5–S6, solution §4.6)

| Failure | Job | Project | Q&A |
|---|---|---|---|
| S5 publish error | `failed` | `failed` or stays `updating` | Off |
| S4 exhausted after recovery | `failed` | knowledge failed | Off; queue fails retryable |
| Partial exclusions | `completed_with_warnings` | `partially_available` | On after S6 |
| Success full coverage | `completed` | `knowledge_ready` | On |

Failed jobs remain readable (phase 25 rule).

## 5. Data model changes

### `knowledgeVersions` (new collection)

| Field | Notes |
|---|---|
| Base | `orgId`, `projectId`, `status: 'A' \| 'D'`, timestamps, actors |
| `sourceVersionId` | ObjectId |
| `graphIdentity` | Opaque object from S4 `carry` (hash/path/version — exact keys §12) |
| `publishedHealth` | Solution-facing: `ready` \| `partially_available` \| `failed` |
| `excludedFileCount` | number |
| `publishedAt` | Date |

Indexes (partial `status: 'A'`):

- `{ orgId, projectId, publishedAt: -1, _id: -1 }` — current/history list for admin.
- `{ orgId, projectId, sourceVersionId }` — lookup by source version.

**`projects`** — write `currentKnowledgeVersionId`, `knowledgeHealth`, `lifecycleStatus` only via
`transitionLifecycle` (phase 17); this phase does not add new project fields beyond using existing ones.

**`jobs`** — no new schema fields; optional recovery state in checkpoint if approved by phase 21
helpers — **§12**.

## 6. API contract — PROPOSED (needs approval before implementation)

**No user-facing HTTP required in this phase** unless product wants early health read before phase 37.

Internal gate contract:

```json
{
  "assertKnowledgeReadable": {
    "input": { "orgId": "…", "projectId": "…" },
    "output": {
      "action": "allow | queue | deny",
      "knowledgeVersionId": "kv_…",
      "code": "KNOWLEDGE_UPDATING | KNOWLEDGE_UNAVAILABLE | …",
      "message": "Project knowledge is being updated."
    }
  }
}
```

Optional later HTTP ( **do not implement without approval** ):

```http
GET /api/v1/projects/:projectId/knowledge/health
Permission: knowledge.view
200 { "knowledgeHealth": "…", "currentKnowledgeVersionId": "…", "lifecycleStatus": "…" }
```

## 7. Configuration & environment variables

**None** for publish/recovery tunables.

### Constants (not env)

| Constant | Home | Purpose |
|---|---|---|
| `KNOWLEDGE_RECOVERY_MAX_ATTEMPTS` | `modules/knowledge/knowledge.recovery.js` | S4 rebuild tries before failed |
| `KNOWLEDGE_PUBLISH_STAGE_TIMEOUT_MS` | `stages/s5KnowledgePublish.js` | S5 wall clock |

Queue message expiry and backoff remain phase 51 / evaluation blockers.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/ingest/stages/s5KnowledgePublish.js` (+ `.test.js`) | **New:** S5 |
| `backend/src/modules/ingest/stages/s6Finalize.js` (+ `.test.js`) | **New:** S6 |
| `backend/src/modules/ingest/ingest.stages.js` | **Change:** wire S5/S6 |
| `backend/src/modules/knowledge/index.js` | **New:** public surface |
| `backend/src/modules/knowledge/knowledgeVersion.model.js` | **New:** schema |
| `backend/src/modules/knowledge/knowledgeVersion.repository.js` (+ `.test.js`) | **New:** tenant-scoped CRUD |
| `backend/src/modules/knowledge/knowledge.publish.js` (+ `.test.js`) | **New:** S5 logic |
| `backend/src/modules/knowledge/knowledge.recovery.js` (+ `.test.js`) | **New:** rematerialize + S4 retry orchestration |
| `backend/src/modules/knowledge/knowledge.gate.js` (+ `.test.js`) | **New:** assertKnowledgeReadable |
| `backend/src/modules/projects/project.lifecycle.js` | **Change:** worker transitions for publish outcomes |
| `backend/src/modules/audit/audit.actions.js` | **Change:** knowledge.completed / knowledge.failed |
| `backend/src/modules/ingest/ingest.events.js` | **Change:** S5/S6 messages |

## 9. Tests (≥ 80% line and branch)

### Unit

- Exclusions present → published health `partially_available`, not `ready`.
- Gate: updating/failed/ready paths return correct action/code.
- `transitionLifecycle` rejects API source for `knowledge_ready`.
- Recovery calls S3/S4 helpers in order (mocked); stops after max attempts.

### Integration

- Full ingest S0–S6 fixture: `KnowledgeVersion` row, project `currentKnowledgeVersionId`, lifecycle
  terminal state, audit row.
- Simulated S4 fail → recovery success → publish → gate allows.
- Simulated recovery exhaust → project failed health; gate denies with `KNOWLEDGE_UNAVAILABLE`.

### Unhappy paths

- Publish without graph identity → `permanent`.
- Cross-tenant publish attempt → no writes.
- Partial file failures from earlier stages → `completed_with_warnings` when job completes.

## 10. Definition of Done

- [ ] S5 and S6 replace placeholders; ingest job can complete end-to-end through S6.
- [ ] `KnowledgeVersion` collection with `status: 'A'|'D'` and indexes synced in tests.
- [ ] Project health/lifecycle updated only via `transitionLifecycle` + worker source.
- [ ] Partial graph exclusions produce partial availability, not full ready.
- [ ] Q&A gate helper exported for phases 50/51/37.
- [ ] Recovery path implemented per approved §12 same-job vs new-job decision.
- [ ] Audit events for knowledge completed/failed without secrets.
- [ ] Job fields via phase 21 helpers only.
- [ ] `docs/data-model.md` updated with `knowledgeVersions` and health field notes.
- [ ] `npm run lint`, `npm test`; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/data-model.md`: `knowledgeVersions`; clarify `knowledgeHealth` on `projects` pending §12
  mapping.
- `docs/architecture.md` §7: align Q&A off/on timeline with implemented gate.
- `backend/solution.md` §4.6 recovery narrative: update only if implementation order differs.
- ADR if recovery job type or health enum mapping becomes a formal decision.

## 12. Risks & open questions

1. **knowledgeHealth naming (cross-cutting Q5):** `docs/data-model.md` lists
   `none|updating|ready|partial|stale|failed`; solution/architecture use
   `ready|partially_available|failed` (+ updating during ingest). **No mapping invented here.**
2. **When Q&A disables (cross-cutting Q6):** At job claim, S3 start, or S4 writer start?
3. **Recovery job vs in-stage (cross-cutting Q7):** Automatic recovery inside the failing ingest job
   versus enqueue `reingest` / dedicated recovery job type?
4. **`stale` health:** When is `stale` set vs `updating` (backend §85, §28)?
5. **Prior KnowledgeVersion rows:** Soft-delete old current version rows or keep all with
   `status: 'A'` and pointer on project only?
6. **Gate vs read lease:** Phase 46/37 read paths — does gate duplicate CodeGraph read lease logic?
7. **Lifecycle on first ingest:** Confirm `processing` → `knowledge_ready` vs `source_received` → …
   path from phase 17 for upload flow.
