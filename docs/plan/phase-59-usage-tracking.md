# Phase 59 — Usage tracking

- **Layer:** BE+FE
- **Depends on:** Phase 13 (API client), Phase 28 (ingest/job completion facts), Phase 49
  (assistant message persist with SDK usage when reported)
- **Unblocks:** Phase 60 (usage rollup retention), Phase 62 (ops may correlate usage with failures)
- **Size:** 1–2 days
- **Requirements covered:** backend/requirments.md §68, §99, §100, §108; frontend/requirments.md §86;
  backend/solution.md §12.2; docs/architecture.md §10

## 1. Goal

After this phase the platform records **actual** backend activity — questions answered, ingest jobs
completed, source bytes accepted, search calls, and token in/out **only when the LLM SDK returns
usage** — at organization, project, and user granularity. Authorized admins see usage dashboards;
every signed-in user sees their own `/me` summary. Nothing is estimated, extrapolated, or backfilled
with guesses. You can see it working by asking a question (phase 50+), completing an upload ingest,
and opening org or project usage in the admin UI with numbers that match persisted events (or
approved rollups), while a chat completion with no SDK usage shows questions counted but omits
token fields rather than fabricating zeros labeled as measured.

## 2. Why this phase is here

Requirements §99–§100 and solution §12.2 require trustworthy metering for enterprise admins,
but phases 28 and 49 only produce the **raw moments** (job finished, message saved). Centralizing
append + read APIs here avoids every module inventing its own counters. Phase 13 ensures the admin
UI uses real HTTP contracts. It must follow Phase 49 so token recording hooks exist at persist
time; ingest bytes come from phase 24/25 counters, not HTTP guesses. Billing integration is out
of scope; this phase is read-only analytics. Retention of old usage rows is **Phase 60**.

## 3. Scope

### In scope

- Persist usage facts as **`projectActivities`** append rows —
  **GET /usage/* aggregates those rows by `occurredAt`** (no daily rollup collection).
- **Counters / facts** (solution §12.2), all from observed backend work:
  - `question.answered` — assistant message reached terminal success (not queued/abstain-only
    unless product defines otherwise in §12).
  - `ingest.job.completed` — terminal ingest/sync job success (job type + byte totals from job
    counters when present).
  - `source.bytes.accepted` — additive bytes from accepted uploads/sync (from stored counts).
  - `search.executed` — successful project search API handling (phase 38).
  - `tokens.input` / `tokens.output` — **only** when phase 45/49 SDK `usage` object present on
    that completion; associate with org, project, user, message id.
- **Read APIs:** `GET /usage/organization`, `GET /usage/projects/:projectId`, `GET /usage/me`
  (solution §12.2).
- Permission: `usage.view` for org and project routes; `/me` for any authenticated user in org.
- Frontend admin usage views (frontend §86): org summary, by project, by user where API exposes;
  show only fields returned — hide token/context rows when absent.
- Idempotent recording: same message id or job id must not double-count on retry (dedupe keys).

### Out of scope (owner phase)

- Estimated tokens, context “% used” without measurement — phase 44/57 own **display** of
  context metrics on chat; usage module does not invent them (§100).
- Invoice generation, quotas, hard limits, overage billing.
- Database query usage (later slice).
- **Retention** of events/rollups (730 days default) — **Phase 60**.
- Real-time streaming usage — poll/Query only.

## 4. Design

### 4.1 Recording pipeline

```text
Domain commit success (message, job, search handler)
    → recordProjectActivity({ orgId, projectId, userId, kind, quantity, unit, sourceRef, dedupeKey })
        → append projectActivities (skip when projectId is missing)
```

`recordProjectActivity` is best-effort for **read** APIs (like audit ADR 0016): failure logs at `error`
with correlation id; business action already succeeded. Usage must never block chat or ingest.

**Token rule (backend §68, §100):** if `usage` is missing from SDK result, record the question
event without token lines; do not write `tokens.*` with 0 unless zero is explicitly reported.

### 4.2 Event kinds (proposed union)

| kind | quantity | unit | sourceRef |
|------|----------|------|-----------|
| `question.answered` | 1 | count | `{ messageId, conversationId }` |
| `ingest.job.completed` | 1 | count | `{ jobId, jobType }` |
| `source.bytes.accepted` | n | bytes | `{ sourceVersionId, jobId? }` |
| `search.executed` | 1 | count | `{ searchRequestId? }` |
| `tokens.input` | n | tokens | `{ messageId }` |
| `tokens.output` | n | tokens | `{ messageId }` |

### 4.3 Read model

**Implemented GET:** aggregate `projectActivities` in Mongo for `{ from, to }` on
`occurredAt` with `$group` by kind. No daily rollup collection.

Response shape (PROPOSED):

```json
{
  "period": { "from": "2026-09-01", "to": "2026-09-12" },
  "totals": {
    "questions": 42,
    "ingestJobs": 3,
    "sourceBytesAccepted": 104857600,
    "searches": 18,
    "tokensInput": 120000,
    "tokensOutput": 45000
  },
  "byProject": [{ "projectId": "...", "questions": 10, "...": "..." }],
  "byUser": [{ "userId": "...", "questions": 5, "...": "..." }]
}
```

Omit keys entirely when no facts exist for that kind (frontend §86: do not show fabricated zeros).

### 4.4 Authorization

- Org route: JWT `orgId`, `usage.view`, aggregate across projects caller may see or entire org —
  **ask §12** whether project-scoped admins see org-wide user breakdown.
- Project route: `requireProjectPermission('usage.view')` or org `usage.view` + project
  membership — align with phase 18 checklist.
- `/me`: caller `userId` only, no `usage.view` required.

### 4.5 Frontend admin usage

- Feature folder under `frontend/src/features/usage/` with routes gated on permission from session.
- Date range picker (UTC boundaries labeled); tables for by-project and by-user when API returns.
- Empty state when all totals omitted; loading/error per phase 13.
- i18n for labels (“Questions”, “Source ingested”, “Tokens (input)” only when present).

## 5. Data model changes

**`projectActivities`** (append, `status: 'A' | 'D'` — soft-delete via retention only).
`GET /usage/*` aggregates these rows by `occurredAt`. There is no daily rollup collection.

| Field | Notes |
|-------|-------|
| `orgId`, `projectId` (required), `userId?` | Scope. Skip the write when `projectId` is missing. |
| `kind` | `ingest.job.completed` \| `source.bytes.accepted` \| `search.executed` |
| `quantity` | number |
| `unit` | `jobs` \| `bytes` \| `calls` |
| `sourceRef` | ids only, no paths/secrets |
| `dedupeKey` | unique per org |
| `occurredAt` | event time |
| `status` | `'A' \| 'D'` |

**Indexes:** unique `{ orgId, dedupeKey }`; `{ orgId, projectId, occurredAt: -1 }`;
`{ orgId, userId, occurredAt: -1 }` (partial `status: 'A'`).

## 6. API contract — PROPOSED (needs approval before implementation)

### `GET /api/v1/usage/organization`

- **Permission:** `usage.view`
- **Query:** `from`, `to` (ISO dates, UTC), optional `groupBy=project|user`
- **Response:** §4.3 shape; 403 without permission; cross-tenant org param → 404 (ADR 0014).

### `GET /api/v1/usage/projects/:projectId`

- **Permission:** `usage.view` + project ACL (phase 18)
- **Query:** `from`, `to`
- **Response:** totals for project; omit org-wide by-user unless approved.

### `GET /api/v1/usage/me`

- **Permission:** authenticated (org from JWT)
- **Query:** `from`, `to`
- **Response:** totals for caller `userId` only.

## 7. Configuration & environment variables

**None.** Default page sizes, max query window (e.g. 366 days), and rollup batch size are named
constants in `usage.constants.js`.

## 8. Files to create or change

| Path | Purpose |
|------|---------|
| `backend/src/modules/masters/projectActivities.js` | Public: `recordProjectActivity`, routes |
| `backend/src/models/projectActivity.model.js` | `projectActivities` schema |
| `backend/src/modules/usage/usage.repository.js` | Append + aggregate queries |
| `backend/src/modules/usage/usage.service.js` | Dedupe, rollup increment |
| `backend/src/modules/usage/usage.routes.js` | GET handlers |
| `backend/src/modules/usage/usageKinds.js` | Kind union |
| `backend/src/modules/usage/*.test.js` | Tests |
| `backend/src/modules/chat/` or message persist | **Change:** record question + tokens |
| `backend/src/modules/jobs/` terminal hooks | **Change:** ingest bytes + job count |
| `backend/src/modules/search/` | **Change:** search.executed |
| `frontend/src/features/usage/usage.api.js` | Client |
| `frontend/src/features/usage/hooks/useOrganizationUsage.js` | React Query |
| `frontend/src/features/usage/hooks/useProjectUsage.js` | React Query |
| `frontend/src/features/usage/pages/UsageOverviewPage.jsx` | Admin UI |
| `frontend/src/features/usage/components/UsageTotalsCard.jsx` | Presentation |
| `frontend/src/i18n/locales/en/usage.json` | Strings |
| `frontend/src/routes/adminRoutes.jsx` | **Change:** link usage page |

## 9. Tests (≥ 80% line and branch)

### Backend

- `recordProjectActivity` dedupe: same `dedupeKey` twice → one row.
- Question persist with SDK usage → question + token events; without usage → question only.
- Ingest completion records bytes from job counters, not request Content-Length.
- GET org aggregates match seeded events (or rollups) for window.
- Project GET with forged `projectId` other org → 404.
- `/me` never returns another user’s rows.

### Frontend

- Renders only API-provided keys; no placeholder token chart when totals omit tokens.
- Forbidden → error state; loading skeleton.

## 10. Definition of Done

- [ ] Usage recording hooked at message, job, and search success paths.
- [ ] Token facts recorded only when SDK reports usage.
- [ ] Three GET routes with correct permissions and ADR 0014 behavior.
- [ ] Admin FE page wired with i18n and honest empty states.
- [ ] Dedupe prevents double count on message/job retry.
- [ ] No estimated usage anywhere in API responses.
- [ ] Coverage ≥ 80% line and branch; lint and tests green.

## 11. Documentation & ADR updates

- `docs/architecture.md` §10: usage recording approach.
- `docs/data-model.md`: `projectActivities` when implemented.

## 12. Risks & open questions

1. **Read model:** GET endpoints aggregate `projectActivities` by `occurredAt`. No daily rollup.
2. **Questions counted:** Include abstain completions? Queued messages that later fail?
3. **Org admin visibility:** Can `usage.view` see all users’ activity org-wide, or only projects
   where they are project_admin?
4. **Chat tokens when provider omits usage:** Confirm UI omits token section entirely (preferred)
   vs showing “not reported” copy.
5. **Search counting:** Count only 200 responses, or include empty results / 403 denials?
6. **Context usage (frontend §86):** Context metrics belong to chat payload (phase 44/57), not
   usage API — confirm no duplicate “context” counter here unless backend §70 defines a stored fact.

### Appendix — recording call sites (implementation checklist)

| Phase / module | When to call `recordProjectActivity` | Dedupe key |
|----------------|--------------------------------|------------|
| 49 message persist | Assistant `done` with success | `{ messageId, kind: question }` |
| 49 message persist | SDK `usage.promptTokens` / completion tokens | `{ messageId, kind: tokens.* }` |
| 28 / 25 job terminal | Ingest `completed` with byte counter | `{ jobId, ingest.job.completed }` |
| 32 repo sync | Sync completed with byte counter | `{ jobId, ingest.job.completed }` |
| 38 search handler | 200 search response | `{ correlationId or hash, search.executed }` |

Bytes must come from **`progressCounters`** or reconciled `SourceFile` totals, never from
client-reported upload size on GET usage.

### Appendix — frontend field visibility

| API field | Show when | Hide when |
|-----------|-----------|-----------|
| `questions` | key present | key absent |
| `tokensInput` / `tokensOutput` | both or either reported | omit section |
| `sourceBytesAccepted` | key present | show “not available” only if product copy approved |

Never chart interpolated daily values between sparse points.
