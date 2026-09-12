# Phase 58 — Notifications

- **Layer:** BE+FE
- **Depends on:** Phase 13 (API client, React Query), Phase 28 (knowledge completed/failed audit
  and terminal ingest jobs), Phase 32 (repository sync job terminal states)
- **Unblocks:** Phase 62 (observability may correlate notification volume), Phase 63 (E2E may
  assert bell badge after ingest)
- **Size:** 1–2 days
- **Requirements covered:** backend/requirments.md §98, §108; frontend/requirments.md §87;
  backend/solution.md §12.1, §9.2; docs/architecture.md §10

## 1. Goal

After this phase the product delivers **in-app notifications only**: when knowledge publish
finishes or fails, when a repository sync completes or fails, or when processing needs human
attention, the backend writes one `Notification` row per recipient and the frontend shows a bell
with unread count, a list, mark-read, and mark-all-read. There is no email, SMS, or push channel,
and no approval-request notification types (live DB path is out of MVP). You can see it working by
completing an ingest job in a project where you are a member, opening the bell, and finding a
readable title/body with a link action to the project processing or sources view — without any
token, stack trace, or credential in the payload.

## 2. Why this phase is here

Phases 28 and 32 already produce the **events** that matter (job terminal state, connection
failures, `user_action_required`), but the UI has no durable, user-specific inbox until this
phase. It depends on Phase 13 so the bell uses the same authenticated client and error envelope
as the rest of the app. It must follow Phase 28 and 32 so emitters know real job outcomes rather
than guessing from polling alone. It cannot land much later without the processing center (35)
and sources health (36) lacking the “something finished” signal users expect (frontend §87).
Retention of old notifications is **Phase 60**, not here.

## 3. Scope

### In scope

- `Notification` Mongoose collection with row `status: 'A' | 'D'` (soft-delete via retention
  only; no user-facing delete API in MVP).
- Notification **types** aligned with solution §12.1:
  - `knowledge.completed`, `knowledge.failed` — ingest/publish terminal success or failure.
  - `repo.sync.completed`, `repo.sync.failed` — `repo_sync` job terminal outcome.
  - `processing.attention` — job ended or stalled with `user_action_required`, or partial
    success below product threshold where the job still completed (same triggers as solution
    table; exact threshold defers to phase 22/25 counters — emit only when backend already
    classified the job that way).
- **Fan-out** from domain events to recipients (see §12 for who receives rows).
- **HTTP list and read APIs** (solution §12.1); optional SSE stream is **not decided here**.
- **Emitters** wired from phase 28 finalize path, phase 32 sync handler, and phase 22 attention
  classification — via a single `notifications` module writer, not ad-hoc inserts.
- Frontend: header bell, unread badge, dropdown or panel list, empty/loading/error states, i18n,
  actionable navigation using `resourceRef` (project id, job id) without inventing URLs the backend
  did not authorize.
- Secret hygiene: notification title/body and `resourceRef` follow backend §148 and frontend §107
  (no credentials, no raw paths that expose other tenants).

### Out of scope (owner phase)

- Email, SMS, web push, Slack — README §5 and solution §14.
- `approval.requested` / `approval.completed` — deferred with live DB Q&A.
- `GET /notifications/stream` SSE — optional in solution §12.1; implementation choice is §12.
- Notification **retention** (90 days / 30 days after read) — **Phase 60**.
- Administrative “broadcast to whole org” — not in requirements; only event-driven fan-out.
- Replacing job polling in the processing center — Phase 35 may still poll jobs; notifications
  are additive.

## 4. Design

### 4.1 Module layout

```text
backend/src/modules/notifications/
├── index.js              public: createNotificationsForEvent, registerRoutes
├── notification.model.js
├── notifications.repository.js
├── notifications.service.js   fan-out + idempotent create per (eventKey, userId)
├── notifications.routes.js
├── notifications.emit.js      called from jobs/knowledge/repo handlers
└── notificationTypes.js       stable type union + title/body templates (ids only in data)
```

Handlers that own terminal job state **call** `emitProjectNotification({ ... })` after commit;
the emitter never receives `reply`/`res` (function-design rule).

### 4.2 When to create notifications

| Source | Type | Trigger (after DB commit) |
|--------|------|---------------------------|
| Ingest S6 / knowledge publish | `knowledge.completed` | Job `completed` or `completed_with_warnings` and health published ready/partial |
| Same | `knowledge.failed` | Job `failed` or publish/recovery exhausted |
| `repo_sync` handler | `repo.sync.completed` | Terminal success, including no-op same commit |
| Same | `repo.sync.failed` | Terminal failure before or after connection update |
| Job control / ingest | `processing.attention` | `failureClass: user_action_required` or documented partial-attention rule |

Each emission carries `orgId`, `projectId`, `jobId?`, `sourceVersionId?`, correlation id for
logs only (not stored on the notification document unless product asks — default: omit).

**Idempotency:** one logical event → one batch of notifications. Use a deterministic
`dedupeKey` (e.g. `{ jobId, type }` or `{ jobId, type, attempt }` for retries) so worker
retries do not duplicate rows. Store `dedupeKey` on the notification or a small
`notificationDeliveries` side table — **ask in §12** which shape is preferred; do not silently
pick without approval.

### 4.3 Fan-out and authorization

Solution §12.1: fan-out to **project members with relevant permissions**. Recipients are always
scoped `orgId` + `userId`; list API returns only the caller’s rows where `status: 'A'`.

Proposed permission gate for **reading**:

- `GET /notifications*` requires `notifications.view` (solution §8.2) **and** JWT org match.
- Rows are never returned for another `userId`.

Who gets a row on emit is an **open question** (§12): all active project members, only users with
`knowledge.view`, only the job triggerer, or a mix by notification type.

### 4.4 Payload shape (stored document)

```text
Notification
├── orgId, userId (recipient)
├── type (enum above)
├── title, body (English defaults; FE i18n may map type + resourceRef)
├── resourceRef: { projectId, jobId?, sourceVersionId? }  — ids only
├── readAt: Date | null
├── dedupeKey?: string
├── createdAt, updatedAt
└── status: 'A' | 'D'
```

No stack traces, provider errors, file paths from other projects, or tokens in `title`/`body`.

### 4.5 Frontend bell

- React Query: `useNotifications({ unreadOnly })` with sensible stale time; refetch on window
  focus and after mark-read mutations.
- Badge shows count from API (`unreadTotal` in list response) — **never** increment locally on
  guess.
- Click row → navigate to project processing or sources route using `resourceRef.projectId`;
  mark read on navigate or explicit control (product: mark on open — document in §6).
- Loading skeleton, empty (“No notifications”), error with retry (phase 13 envelope).
- Responsive: bell visible at 375px; panel does not trap focus permanently (accessibility).

### 4.6 Delivery transport (list vs SSE)

Solution §12.1 lists poll endpoints and marks `GET /notifications/stream` optional. Phase 58
**must implement list + mark-read**; SSE is implemented only if §12 question 13 is answered
“yes” before code starts. If poll-only, FE uses interval or refetch-on-focus — do not invent SSE
client code without backend stream.

## 5. Data model changes

**New collection: `notifications`**

| Field | Type | Notes |
|-------|------|-------|
| `orgId` | ObjectId | Tenant scope |
| `userId` | ObjectId | Recipient |
| `type` | string | Enum §4.2 |
| `title`, `body` | string | Bounded length constants |
| `resourceRef` | subdoc | ids only |
| `readAt` | Date \| null | |
| `dedupeKey` | string | Optional unique with userId |
| `status` | `'A' \| 'D'` | Default `'A'` |
| `createdAt`, `updatedAt` | Date | |

**Indexes (proposed):**

- `{ orgId, userId, status, createdAt }` — list + unread filter, partial `{ status: 'A' }`.
- Unique `{ orgId, userId, dedupeKey }` partial where `dedupeKey` exists — duplicate suppression.

No change to `jobs` schema; emitters read terminal fields from existing job documents.

## 6. API contract — PROPOSED (needs approval before implementation)

### `GET /api/v1/notifications`

- **Permission:** `notifications.view`
- **Query:** `unread=1` optional; `cursor` keyset (e.g. `createdAt` + `_id`).
- **Response:**

```json
{
  "items": [
    {
      "id": "ntf_01J...",
      "type": "knowledge.completed",
      "title": "Knowledge update completed",
      "body": "Project \"Payments\" finished processing.",
      "resourceRef": { "projectId": "prj_...", "jobId": "job_..." },
      "readAt": null,
      "createdAt": "2026-09-12T10:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "unreadTotal": 3
}
```

- Cross-tenant: N/A (org from JWT). Wrong notification id on mark-read → `404 NOT_FOUND`
  (ADR 0014).

### `POST /api/v1/notifications/:notificationId/read`

- **Permission:** `notifications.view`
- Sets `readAt` if recipient matches caller and `status: 'A'`.
- **Response:** `200 { id, readAt }`

### `POST /api/v1/notifications/read-all`

- **Permission:** `notifications.view`
- Marks all unread for caller in org.
- **Response:** `200 { updatedCount }`

### `GET /api/v1/notifications/stream` (optional — approval gated)

- **Permission:** `notifications.view`
- **Accept:** `text/event-stream` — only if §12 Q13 chooses SSE before implementation.
- Events: `notification`, `heartbeat` — exact names PROPOSED; align with architecture §9 if added.

## 7. Configuration & environment variables

**None.** Page size, title/body max length, and default list limit are named constants in
`notifications.constants.js` (e.g. `NOTIFICATION_LIST_PAGE_SIZE_DEFAULT`, `NOTIFICATION_BODY_MAX_CHARS`).

## 8. Files to create or change

| Path | Purpose |
|------|---------|
| `backend/src/modules/notifications/index.js` | Public module surface |
| `backend/src/modules/notifications/notification.model.js` | Schema + indexes |
| `backend/src/modules/notifications/notifications.repository.js` | Tenant-scoped CRUD |
| `backend/src/modules/notifications/notifications.service.js` | Fan-out, dedupe, mark read |
| `backend/src/modules/notifications/notifications.routes.js` | HTTP routes + permissions |
| `backend/src/modules/notifications/notifications.emit.js` | Emitter API for jobs module |
| `backend/src/modules/notifications/notificationTypes.js` | Type union + copy helpers |
| `backend/src/modules/notifications/*.test.js` | Unit + route tests |
| `backend/src/modules/jobs/ingest finalize hook` | **Change:** call emitter on terminal ingest |
| `backend/src/modules/jobs/repoSync.handler.js` | **Change:** call emitter on sync terminal |
| `backend/src/app.js` or route registrar | Register notification routes |
| `frontend/src/features/notifications/` | Bell, list, hooks, i18n keys |
| `frontend/src/features/notifications/hooks/useNotifications.js` | React Query list + unread |
| `frontend/src/features/notifications/hooks/useMarkNotificationRead.js` | Mutations |
| `frontend/src/features/notifications/components/NotificationBell.jsx` | Header UI |
| `frontend/src/features/notifications/components/NotificationList.jsx` | Panel content |
| `frontend/src/features/notifications/notifications.api.js` | API client wrappers |
| `frontend/src/layout/AppHeader.jsx` | **Change:** mount bell |
| `frontend/src/i18n/locales/en/notifications.json` | User-facing strings |

## 9. Tests (≥ 80% line and branch)

### Backend unit

- Fan-out creates N rows per recipient set; dedupeKey prevents duplicates on double emit.
- List scoped to `orgId` + `userId`; other user’s id on mark-read → 404.
- `status: 'D'` rows excluded from list.
- Title/body builder never includes forbidden substrings from job error payloads (sanitizer).

### Backend integration

- Terminal ingest fixture → recipients receive `knowledge.completed` or `failed` matching job.
- Sync job fixture → `repo.sync.*` types.
- Mark one read → unreadTotal decrements; read-all clears badge count.

### Backend unhappy paths

- Emit with invalid `projectId` / org mismatch → no rows, error logged, job still terminal.
- Missing `notifications.view` → 403 on list.

### Frontend unit

- Bell shows loading, empty, error, and populated states from query status.
- Badge uses API `unreadTotal` only.
- Notification row click navigates with `resourceRef.projectId`; no secret text rendered (§107).

### Frontend integration (Vitest + MSW)

- List fetch maps envelope to UI; mark-read mutation invalidates query.

## 10. Definition of Done

- [ ] `notifications` collection deployed with indexes and `status: 'A'|'D'`.
- [ ] Emitters wired for knowledge and repo sync terminal paths plus processing attention.
- [ ] List, mark-read, read-all APIs live with `notifications.view` and ADR 0014 404 behavior.
- [ ] No email/SMS/approval types in code or catalog.
- [ ] Frontend bell shipped with i18n and responsive layout.
- [ ] Dedupe prevents duplicate rows on worker retry (test proves).
- [ ] Notification payloads contain no secrets (test + manual checklist).
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch on new modules.

## 11. Documentation & ADR updates

- `docs/architecture.md` §10: confirm notifications row matches implemented types.
- `docs/data-model.md`: add `notifications` when schema merges (same PR as code).
- No new ADR unless SSE stream adds a new long-lived connection policy beyond phase 50 chat.

## 12. Risks & open questions

1. **SSE vs poll (plan Q13):** Should MVP ship `GET /notifications/stream`, or list + React Query
   refetch only? Solution marks SSE optional — do not implement stream until decided.
2. **Recipient set:** On `knowledge.completed`, notify all project members, only users with
   `knowledge.view`, only the user who triggered ingest, or org admins plus triggerer?
3. **Dedupe storage:** Unique index on `(orgId, userId, dedupeKey)` vs separate delivery ledger?
4. **Mark read UX:** Mark on panel open vs explicit button only?
5. **processing.attention:** Exact job states that emit (only `user_action_required`, or also
   `completed_with_warnings` with failed file ratio)?
6. **Administrative events:** Frontend §87 mentions administrative events — which admin actions
   (user create, credential revoke) get notifications in MVP vs audit-only (phase 10)?
