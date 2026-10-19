# Phase 60 — Retention policies & scheduled cleanup

- **Layer:** BE+FE
- **Depends on:** Phase 10 (audit append-only + retention hook flag), Phase 13 (FE client),
  Phase 21 (`scheduledAt` scheduler), Phase 41 (conversation soft-delete semantics)
- **Unblocks:** Phase 61 (security pass verifies retention queries scope `orgId`), Phase 62
- **Size:** 1–2 days
- **Requirements covered:** backend/requirments.md §101–103, §102; frontend/requirments.md §86A;
  backend/solution.md §12.3, §9.1; docs/architecture.md §10

## 1. Goal

A **scheduled worker job** (`aged_org_data_cleanup`) enforces each organization's retention
policy (defaults from solution §12.3, overridable via Admin Retention). Soft-delete only
(`status: 'D'`); GridFS bytes are orphan-marked, not hard-purged. Project delete soft-deletes
the project row and schedules the same cleanup job to cascade children; audit rows remain until
their own retention window.

## 2. Status (shipped)

| Piece | Location |
|-------|----------|
| Cleanup job + hourly enqueue | [`backend/src/worker/agedOrgDataCleanupJob.js`](../../backend/src/worker/agedOrgDataCleanupJob.js) |
| Defaults + GET/PATCH policy | [`backend/src/modules/masters/organizations.js`](../../backend/src/modules/masters/organizations.js) |
| Routes | `GET/PATCH /masters/organizations/*RetentionPolicy` in [`route.js`](../../backend/src/http/route.js) (`org.manage`) |
| Org schema field | `organizations.retentionPolicy` |
| Project delete → ensure cleanup soon | [`projects.js`](../../backend/src/modules/masters/projects.js) → [`ensureAgedOrgDataCleanupJobSoon`](../../backend/src/modules/masters/jobs.helper.js) |
| Admin UI | [`AdminRetention.jsx`](../../frontend/src/features/admin/AdminRetention.jsx) |

**Not used:** a fifth `modules/retention/` package or `retention.routes.js` (forbidden by
four-module + central catalog rules).

## 3. Locked decisions

| Topic | Decision |
|-------|----------|
| Policy storage | Embedded `retentionPolicy` on `organizations` (no separate collection) |
| Writable MVP | Yes — GET/PATCH + Admin form (`org.manage`) |
| Job shape | One `aged_org_data_cleanup` job per active org (`projectId: null`) |
| Notifications | Soft-delete if unread ≥ `notificationDays` **or** read ≥ `notificationReadDays` after `readAt` |
| Jobs (age rule) | Terminal statuses only (`completed`, `completed_with_warnings`, `failed`, `cancelled`) |
| Ready keep-N | `publishedHealth: 'ready'`, always keep `currentKnowledgeVersionId` |
| Usage | Soft-delete `projectActivities` by `occurredAt` (no separate rollups collection) |
| Project cascade | After project soft-delete, `ensureAgedOrgDataCleanupJobSoon`; cascade inside cleanup |
| GridFS hard purge | Out of scope — only `markGridFsFilesOrphaned` |

## 4. Default policy (solution §12.3)

| Field | Default |
|-------|---------|
| `readySourceVersionsKeep` | 3 |
| `jobDays` | 180 |
| `notificationDays` | 90 |
| `notificationReadDays` | 30 |
| `usageDays` | 730 |
| `conversationDays` | 365 |
| `auditDays` | 730 |

Bounds: keep 1–20; day fields 1–3650. Constants live next to the org resource
(`RETENTION_POLICY_DEFAULTS` / `RETENTION_POLICY_BOUNDS`).

## 5. Cleanup behavior

For each org job:

1. Load effective `retentionPolicy` (merge missing fields with defaults).
2. Active projects: keep last N ready knowledge versions (+ current); soft-delete older
   knowledge/source versions, `sourceFiles`, `documentSections`; orphan GridFS ids.
3. Soft-delete aged terminal jobs, notifications, project activities, archived conversations
   (+ messages + matching `chatCheckpoints`).
4. Soft-delete aged audit via `{ retentionJob: true }`.
5. For projects with `status: 'D'`, cascade soft-delete remaining active children (sources,
   knowledge, sections, files, repository connections, conversations, messages, jobs,
   notifications, project activities, chat checkpoints). **Never** touch audit here.

## 6. API

### `GET /api/v1/masters/organizations/getRetentionPolicy`

- **Permission:** `org.manage`
- **Response:** effective policy object (defaults filled in).

### `PATCH /api/v1/masters/organizations/updateRetentionPolicy`

- **Permission:** `org.manage` + Idempotency-Key
- **Body:** subset of policy fields within bounds
- **Audit:** `retention.policy_changed` (previous/next counts only)

## 7. Configuration & environment variables

**None.** Scheduler tick and bounds are named constants. Worker poll/lease env from phase 01 only.

## 8. Out of scope

- Hard GridFS purge (requires ADR when enabled)
- Backup/restore product
- Legal hold / e-discovery
- Cross-org retention

## 9. Tests

- Keep-last-N + documentSections soft-delete
- Org policy override for job days
- Project cascade; audit remains `A`
- `ensureAgedOrgDataCleanupJobSoon` enqueue/bump
- Policy GET/PATCH authz + bounds + audit
- AdminRetention load/save + permission gate

## 10. Definition of Done

- [x] Retention handler registered; runs via `scheduledAt` without blocking HTTP
- [x] Soft-delete only; audit uses retention hook
- [x] Project delete schedules cascade; audit retained until auditDays
- [x] GridFS hard purge not implemented
- [x] Writable FE settings with `org.manage`
- [x] Coverage for touched surfaces
