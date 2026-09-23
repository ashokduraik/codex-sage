# Phase 35 — Frontend processing center & persistent status slice

- **Layer:** FE
- **Depends on:** Phase 19 (frontend projects slice), Phase 22 (job control & progress)
- **Unblocks:** — (README); Phases 33–34 hand off `jobId` consumed here
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §20–§28 (knowledge creation through
  processing history), §27 (retry), §89–§90 (loading & errors); `backend/requirments.md` §33–§37,
  §154; decision **D7**

## 1. Goal

After this phase the Processing center and header processing chip read real jobs from the API.
Users see stage-based progress, human-readable events, warnings and errors from the backend
progress projection (Phase 22), and can retry or cancel when the API allows. Nothing invents
percent complete when the backend sends `percent: null` (backend §33, Phase 22 §4).

You can see it working by uploading or connecting a project, opening `/processing` or the chip
in the header, watching stages advance via polling (unless product chooses SSE — §12), retrying a
failed job with `Idempotency-Key`, and still seeing failed operations in history after navigation
(frontend §24, §28).

## 2. Why this phase is here

Phases 20 and 22 expose job list, detail, progress, retry, and cancel. Phase 19 leaves Processing
on `useAppData().jobs` with fake `progress` percentages (`ProcessingIndicator` shows `job.progress`
%). Migrating processing UI unblocks honest ingest feedback for Phases 33–34 hand-offs and satisfies
§22 persistent status without blocking Sources/Health (Phase 36).

It must not precede Phase 22 (no progress block or control routes). It must not implement chat
SSE (Phase 50) or confuse upload HTTP progress (Phase 33) with worker stages.

## 3. Scope

### In scope

- Jobs API module wrapping Phase 20 list/detail and Phase 22 retry/cancel + progress shape.
- React Query: project job list, job detail with polling interval as a **named constant** (not env)
  until SSE decision (§12).
- `ProcessingCenterPage.jsx` rewired: active jobs, history, detail expansion, activity from
  `events` / progress `stages` — not mock `jobs` array.
- `ProcessingIndicator.jsx` in `features/layout/`: link to processing center; label from
  `currentStage` / progress labels — **remove fake `%`** unless backend sends `percent`.
- Optional: project-scoped processing snippet on overview when a job is active (frontend §24) —
  minimal banner linking to center.
- Retry/cancel mutations with action feedback and idempotency on retry (Phase 22).
- i18n; remove processing mock usage from touched files.
- Colocated tests including error details panel (frontend §26).

### Out of scope (owner phase)

- Source upload HTTP progress — **Phase 33**.
- Sources version list — **Phase 36**.
- Notifications bell for job completion — **Phase 58**.
- Server-Sent Events for jobs — **only if product approves**; do not implement SSE silently.
- Re-ingest button — **Phase 29** backend + later FE.
- Playwright — **Phase 63**.

## 4. Design

### 4.1 Feature layout

```text
frontend/src/features/processing/
  api/jobsApi.js                 list, get, retry, cancel
  api/jobTypes.js                mirror Phase 20/22 DTOs
  hooks/useProjectJobs.js        list query + filters
  hooks/useJob.js                detail query + poll
  hooks/useJobControl.js         retry/cancel mutations
  jobProgressMap.js              stage.state → icon/tone; jobStatus → history glyph
  ProcessingCenterPage.jsx       main UI
frontend/src/features/layout/
  ProcessingIndicator.jsx        header chip (consume useActiveProjectJob or similar)
```

Query keys:

```text
['jobs', 'list', projectId, { jobStatus, cursor }]
['jobs', 'detail', jobId]
['jobs', 'active']               optional global active job for header (derived from list)
```

Polling: `refetchInterval` active while `jobStatus` ∈ `{ pending, retrying, running }` and
document in §12 whether interval is fixed or backoff — **ask product**; default proposal constant
`JOB_DETAIL_POLL_INTERVAL_MS = 3000` in the hook file until SSE exists.

### 4.2 Progress rendering (anti-fabrication)

| Field (Phase 22 progress block) | UI use |
|---|---|
| `percent` | Render bar **only when non-null** |
| `stages[]` with `state` | Checklist (frontend §20) |
| `itemsProcessed` / `itemsFailed` | Counts in errors (frontend §25) |
| `warnings` / `errors` | Summary + details (frontend §26) |
| `retry.available` / `mode` / `reason` | Show/hide Retry + explain |
| `cancellation.requested` | “Cancellation requested” — not “cancelled” until status changes |
| `knowledgeAvailability` | Copy for ask paused/queued/available — no local guess |
| `events[]` on detail | Activity log (frontend §21) — messages only, `data` in details panel |

Do not interpolate percent from stage index. Do not show spinner percent in header (remove
`ProcessingIndicator` `percent` prop usage from mocks).

### 4.3 Retry and cancel (Phase 22 **PROPOSED**)

- `POST /api/v1/jobs/:jobId/retry` with `Idempotency-Key`.
- `POST /api/v1/jobs/:jobId/cancel` — `202` when running with cooperative cancel.

Buttons respect `retry.available` and job status; disabled with tooltip/i18n when
`not_retryable` including reason from `retry.reason`. Cancel confirms destructive action;
shows `role="alert"` on `409 INVALID_JOB_TRANSITION`.

### 4.4 Persistent indicator (frontend §22)

`AppShell` / `Header` loads the best candidate active job:

- Prefer `running`/`retrying`, then oldest `pending` ingest for current project if context known,
  else org-wide active job list if API allows — **if list is project-scoped only**, chip appears
  when user is inside a project with an active job or when a lightweight “my active jobs” query
  exists. **Open question:** global chip without a project context (§12).

Chip text example keys: `header.processingStage` with `{ stageLabel, projectName }` — not percent.

### 4.5 Processing history (frontend §28)

History section uses `GET /projects/:projectId/jobs` with cursor pagination, filter
completed/failed/cancelled. Row shows `completedAt`, `jobStatus`, `partialSuccess` flag.
Detail drawer loads `GET /jobs/:jobId` including full progress + events.

### 4.6 Empty, loading, error

Skeletons for list (§89). Query failure: inline alert + retry. Job `404`: not found panel.
Correlation id on serious failures (§90).

### 4.7 Responsiveness

Processing cards stack at 375 px; stage list remains vertical; activity log scrolls internally.

## 5. Data model changes

**None** (frontend).

## 6. API contract — implemented

No new backend endpoints in this FE phase. Consume the shipped Phase 20/22 jobs APIs.

### `GET /api/v1/projects/:projectId/jobs` (Phase 20) — **implemented**

- Permission: `projects.view` + membership.
- Query: `cursor`, `limit`, optional `jobStatus`.
- Response: `items[]`, `pageInfo`.

### `GET /api/v1/jobs/:jobId` (Phase 20 + Phase 22) — **implemented**

- Flattened progress on the job detail DTO: `percent`, `stages`, `events`, `retry`,
  `cancellation`, `knowledgeAvailability`. There is **no** nested `progress` object.
  `percent` may be `null` — do not invent a percentage.

### `POST /api/v1/jobs/:jobId/retry` (Phase 22) — **implemented**

- Header: `Idempotency-Key`.
- Response `202` with updated status / retry metadata.

### `POST /api/v1/jobs/:jobId/cancel` (Phase 22) — **implemented**

- Cooperative cancel for `running`; while `cancellation.requested` the UI shows
  “Cancellation requested”.

## 7. Configuration & environment variables

**None.** Poll interval and list page size are named constants next to hooks (`env-config.mdc`).

| Constant (proposal) | Value | Where |
|---|---|---|
| `JOB_DETAIL_POLL_INTERVAL_MS` | `3000` | `hooks/useJob.js` |
| `JOB_LIST_PAGE_SIZE` | `20` | `hooks/useProjectJobs.js` |

Replace polling with SSE only after explicit product decision (§12).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/processing/api/jobsApi.js` | **New** |
| `frontend/src/features/processing/api/jobsApi.test.js` | **New** |
| `frontend/src/features/processing/api/jobTypes.js` | **New** |
| `frontend/src/features/processing/hooks/useProjectJobs.js` | **New** |
| `frontend/src/features/processing/hooks/useJob.js` | **New** |
| `frontend/src/features/processing/hooks/useJobControl.js` | **New** |
| `frontend/src/features/processing/hooks/*.test.jsx` | **New** |
| `frontend/src/features/processing/jobProgressMap.js` | **New** |
| `frontend/src/features/processing/jobProgressMap.test.js` | **New** |
| `frontend/src/features/processing/ProcessingCenterPage.jsx` | Replace useAppData |
| `frontend/src/features/processing/ProcessingCenterPage.test.jsx` | Rewrite |
| `frontend/src/features/processing/index.js` | Export hooks |
| `frontend/src/features/layout/ProcessingIndicator.jsx` | Real job label, no fake % |
| `frontend/src/features/layout/ProcessingIndicator.test.jsx` | Update |
| `frontend/src/features/layout/Header.jsx` | Wire indicator to job query |
| `frontend/src/features/layout/Header.test.jsx` | Active job present/absent |
| `frontend/src/shared/i18n/locales/en.json` | Processing, retry, cancel, stages |

Remove `jobs` / `retryJob` usage from `AppDataContext` only when no remaining importers — D7
may leave mock jobs until Phase 36/others drop them; this phase removes processing imports only.

## 9. Tests (≥ 80% line and branch)

### Unit

- `jobProgressMap`: `completed` / `failed` / `pending` stage icons; unknown stage safe fallback.
- Retry mutation sends `Idempotency-Key`; cancel handles `202`.

### Component

- Center: running job shows stage list from API fixture, **no bar when `percent: null`**.
- Failed job: Retry visible when `retry.available`; hidden when not.
- Activity log toggles; messages from `events[].message`.
- Error panel shows `errors[].message` and affected counts — not stack traces.
- `ProcessingIndicator` hidden when no active job; no `%` text in snapshot.
- Partial success copy uses API counts (frontend §25).

### Unhappy paths

- Retry `409`: alert with message.
- List failure: retry button refetches.
- Polling stops when job reaches terminal status (assert `refetchInterval` disabled).

## 10. Definition of Done

- [ ] `ProcessingCenterPage` and `ProcessingIndicator` do not use mock jobs or fabricated `%`.
- [ ] Progress UI driven by Phase 20/22 fields; `percent` only when backend sends it.
- [ ] Retry/cancel wired to Phase 22 routes with idempotency on retry.
- [ ] Failed jobs remain visible in history after navigation (frontend §24, §28).
- [ ] i18n complete; action feedback on retry/cancel.
- [ ] No SSE unless §12 question answered affirmatively with a defined endpoint.
- [ ] Responsive 375 / 768 / 1280; ≥ 80% coverage on touched files.

## 11. Documentation & ADR updates

- If polling interval becomes standard, note in frontend API client doc — no ADR unless SSE added.
- `docs/architecture.md` unchanged unless SSE job stream is approved later.

## 12. Risks & open questions

Ask the user; do not assume.

1. **Poll vs SSE for jobs.** Phase 20/22 describe REST read models only. Should the UI poll
   `GET /jobs/:jobId` on an interval, use list polling only, or wait for a future job SSE
   endpoint? **Do not implement SSE without an approved contract.**
2. **Global processing chip scope.** When the user is on Home / admin, should the header show
   active jobs across projects? Requires list API scope confirmation.
3. **Progress block availability.** If Phase 22 lags Phase 20, should UI ship with events-only
   fallback?
4. **Route shape (Phase 22 §12 Q3).** Flat `/jobs/:jobId` vs nested under project — client must
   match approved backend.
5. **Cancel UX while running.** Show `202` cooperative cancel — copy must say processing stops at
   next stage (Phase 22 §4.3).
6. **Knowledge completion CTA (frontend §29).** “Ask a question” / “Explore knowledge” on job
   complete — gate on `isProjectAskable` from Phase 19; defer explorer to Phase 40.
7. **Concurrent jobs display.** Multiple actives per project — UI selection rules (newest ingest?).
