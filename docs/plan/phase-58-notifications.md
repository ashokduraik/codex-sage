# Phase 58 — Notifications (as-built)

- **Layer:** BE+FE
- **Depends on:** Phase 13 (API client, React Query), Phase 28 (knowledge completed/failed),
  Phase 32 (repository sync terminal states), Phase 21 (worker schedule terminal hook)
- **Unblocks:** Phase 62 (observability may correlate notification volume), Phase 63 (E2E may
  assert bell badge after ingest)
- **Size:** 1–2 days (implementation complete; this doc records as-built)
- **Requirements covered:** backend/requirments.md §98, §108; frontend/requirments.md §87;
  backend/solution.md §12.1, §9.2; docs/architecture.md §10

## 1. Goal

The product delivers **in-app notifications only**: when knowledge publish finishes or fails,
when a repository sync completes or fails, or when processing needs human attention, the backend
writes one `Notification` row per recipient and the frontend shows a bell with unread presence,
a list, mark-read, and mark-all-read. There is no email, SMS, push, or SSE stream, and no
approval-request notification types. Completing an ingest job in a project where you are an
eligible member surfaces a readable title/body with a link to processing or sources — without
tokens, stack traces, or credentials in the payload.

## 2. Why this phase is here

Phases 28 and 32 produce the events that matter; this phase is the durable user-specific inbox.
Retention of old notifications is **Phase 60**.

## 3. Scope

### In scope (shipped)

- `notifications` collection with row `status: 'A' | 'D'` (soft-delete via retention only; no
  user-facing delete API in MVP).
- Types: `knowledge.completed`, `knowledge.failed`, `repo.sync.completed`, `repo.sync.failed`,
  `processing.attention`.
- Fan-out from worker terminal finish via `emitNotificationsForJobTerminal`.
- HTTP list, mark-read, mark-all-read under masters path shape.
- Frontend header bell, presence badge from `unreadTotal`, panel list, empty/loading/error,
  i18n, navigate via `resourceRef`.

### Out of scope

- Email, SMS, web push, Slack.
- `approval.requested` / `approval.completed`.
- `GET …/notifications/stream` SSE — poll + refetch-on-focus only.
- Notification retention — **Phase 60**.
- Org-wide admin broadcast; admin lifecycle events stay audit-only.
- Replacing job polling in the processing center — notifications are additive.

## 4. Design (as-built)

### 4.1 Module layout (four-module rules)

```text
backend/src/models/notification.model.js     schema + indexes
backend/src/modules/masters/notifications.js emit, list, mark-read, *Http adapters
backend/src/http/route.js                    GET/POST registration under masters
backend/src/worker/schedule.js               calls emitNotificationsForJobTerminal on terminal
frontend/src/features/notifications/         bell, hooks, API client
```

There is **no** `backend/src/modules/notifications/` package and **no** per-resource
`notifications.routes.js`. Models stay in `backend/src/models/`. Routes stay in `route.js`.

### 4.2 When to create notifications

| Source | Type | Trigger |
| --- | --- | --- |
| Knowledge build/rebuild terminal | `knowledge.completed` / `knowledge.failed` | Job completed or failed |
| `connected_repo_pull` terminal | `repo.sync.completed` / `repo.sync.failed` | Sync success or failure |
| Any mapped job with `failureClass: user_action_required` | `processing.attention` | May co-emit with failed type |

**Idempotency:** required `dedupeKey` per row; unique partial index
`{ orgId, userId, dedupeKey }` where `status: 'A'`. Worker retries ignore duplicate key inserts.

### 4.3 Fan-out and authorization

Recipients: active project members + `projectAccessMode: 'all'` users, filtered by type
permission; job `createdBy` is always a candidate (`extraUserIds`).

| Type | Receive permission |
| --- | --- |
| `knowledge.*` | `knowledge.view` |
| `repo.sync.*` | `projects.view` |
| `processing.attention` | `knowledge.trigger` |

List/mark APIs require `notifications.view`. Rows are never returned for another `userId`.
Wrong id → `404 NOT_FOUND` (ADR 0014).

### 4.4 Payload shape

See [`docs/data-model.md`](../data-model.md) `notifications` and
[`backend/src/models/notification.model.js`](../../backend/src/models/notification.model.js).

Fields: `orgId`, `userId`, `type`, `title`, `body`, `resourceRef` (`projectId`, optional
`jobId` / `sourceVersionId`), `readAt`, `dedupeKey`, `status`, timestamps / actors from base
schema. No secrets in title/body.

### 4.5 Frontend bell

- React Query list with 30s poll + refetch-on-focus.
- Badge: presence-dot when `unreadTotal > 0` (not a numeric count in MVP).
- Mark-on-open when navigating from a row; mark-all-read control in panel.
- Navigate via `resourceRef.projectId` (processing vs sources path helper).

### 4.6 Delivery transport

List + mark-read only. No SSE client or stream route.

## 5. Data model changes

**Already shipped** — no further schema work in this phase. Collection `notifications` with
indexes documented in `docs/data-model.md`.

## 6. API contract — as implemented

### `GET /masters/notifications/list`

- **Permission:** `notifications.view`
- **Query:** `unread=1` optional; keyset `cursor`; `limit`
- **Response:** `{ items, nextCursor, unreadTotal }`

### `POST /masters/notifications/markRead/:notificationId`

- **Permission:** `notifications.view`
- Sets `readAt` when recipient matches and `status: 'A'`
- **Response:** `200 { id, readAt }`

### `POST /masters/notifications/markAllRead`

- **Permission:** `notifications.view`
- **Response:** `200 { updatedCount }`

No `/masters/notifications/stream`.

## 7. Configuration & environment variables

**None.** Page size and title/body max lengths are named constants in
`backend/src/modules/masters/notifications.js`.

## 8. Files (as-built)

| Path | Purpose |
| --- | --- |
| `backend/src/models/notification.model.js` | Schema + indexes |
| `backend/src/modules/masters/notifications.js` | Emit, list, mark-read, HTTP |
| `backend/src/modules/masters/index.js` | Barrel exports |
| `backend/src/http/route.js` | Route catalog entries |
| `backend/src/worker/schedule.js` | Terminal emit hook |
| `backend/tests/modules/masters/notifications*.test.js` | Service + route tests |
| `frontend/src/features/notifications/*` | Bell, hooks, API |
| `frontend/src/features/layout/Header.jsx` | Mounts bell |
| `frontend/tests/features/notifications/*` | Bell tests |

## 9. Tests (≥ 80% line and branch)

Covered / expected:

- Fan-out + dedupeKey prevents duplicates on double emit.
- List scoped to `orgId` + `userId`; other user’s id on mark-read → 404.
- `status: 'D'` rows excluded from list.
- Missing `notifications.view` → 403.
- Title/body builders never include job error / token substrings.
- Bell loading / empty / error / populated; badge from `unreadTotal` only.

## 10. Definition of Done

- [x] `notifications` collection with indexes and `status: 'A'|'D'`.
- [x] Emitters wired for knowledge, repo sync, and processing attention (via worker schedule).
- [x] List, mark-read, read-all with `notifications.view` and ADR 0014 404 behavior.
- [x] No email/SMS/approval types in code or catalog.
- [x] Frontend bell with i18n (presence-dot badge).
- [x] Dedupe prevents duplicate rows on worker retry.
- [x] Notification payloads contain no secrets (templates by construction; tests harden).
- [ ] Lint/test green on touched polish — verify in implementation PR.

## 11. Documentation & ADR updates

- `docs/architecture.md` §10 — in-app only; aligns with types above.
- `docs/data-model.md` — `notifications` section already present.
- No SSE ADR.

## 12. Locked decisions (closed)

1. **SSE vs poll:** Poll + refetch-on-focus only; no stream route.
2. **Recipient set:** Members + all-access users filtered by type permission; job triggerer always
   a candidate.
3. **Dedupe storage:** `dedupeKey` on the notification document + unique partial index (no
   separate delivery ledger).
4. **Mark read UX:** Mark on panel open / row navigate; plus mark-all-read.
5. **processing.attention:** Emit when `failureClass === 'user_action_required'` (may co-emit with
   failed type). Not every `completed_with_warnings`.
6. **Administrative events:** Deferred — audit-only in MVP; not inbox rows.
7. **Badge:** Presence-dot from `unreadTotal > 0`; not a numeric count in MVP.
