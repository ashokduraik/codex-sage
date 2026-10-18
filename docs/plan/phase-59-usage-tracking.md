# Phase 59 — Usage tracking

- **Layer:** BE+FE
- **Depends on:** Phase 13 (API client), Phase 28 (ingest/job completion facts), Phase 49
  (assistant message persist with SDK usage when reported)
- **Unblocks:** Phase 60 (usage retention), Phase 62 (ops may correlate usage with failures)
- **Size:** 1–2 days
- **Requirements covered:** backend/requirments.md §68, §99, §100, §108; frontend/requirments.md §86;
  backend/solution.md §12.2; docs/architecture.md §10

## 1. Goal

The platform records **actual** backend activity — questions answered, ingest jobs completed,
source bytes accepted, search calls, and token in/out **only when the LLM SDK returns usage** —
at organization, project, and user granularity. Authorized admins see usage dashboards; every
signed-in user can call `/me`. Nothing is estimated. Chat completions with no SDK usage count
questions but omit token fields.

## 2. Locked product decisions

| Topic | Choice |
| ----- | ------ |
| `question.answered` | Only assistant `messageStatus === 'completed'` |
| Org GET visibility | Accessible projects via `resolveAccessibleProjectFilter` |
| Zero totals | Omit keys whose sum is 0 |
| Project GET ACL | `withProjectAccess('usage.view')` |
| Tokens | Only when SDK reports a finite count (including explicit `0`) |
| Paths | `/masters/projectActivities/*` (not `/usage/*`) |

## 3. Scope

### In scope

- Persist facts as **`projectActivities`** append rows; GET aggregates by `occurredAt`.
- Kinds: `ingest.job.completed`, `source.bytes.accepted`, `search.executed`,
  `question.answered`, `tokens.input`, `tokens.output`.
- Read APIs under masters/projectActivities; permission `usage.view` for org/project; `/me`
  for any authenticated user.
- Admin UI at `/admin/usage` (feature under `frontend/src/features/admin/`).
- Idempotent recording via `dedupeKey`.

### Out of scope

- Estimated tokens / context % on usage API (chat payload owns context metrics).
- Billing, quotas, retention (Phase 60).

## 4. Design

```text
Domain commit success (message completed, job, search)
    → recordProjectActivity({ orgId, projectId, userId, kind, quantity, unit, sourceRef, dedupeKey })
        → append projectActivities (skip when projectId is missing)
```

Best-effort writes (like audit): failure logs; business action already succeeded.

### Recording call sites

| Module | When | Dedupe key |
|--------|------|------------|
| `conversation.helper` finalize | `messageStatus === 'completed'` | `question.answered:${messageId}` |
| same | finite `usage.inputTokens` / `outputTokens` | `tokens.input|output:${messageId}` |
| worker job terminal | ingest/sync completed | `ingest.job.completed:${jobId}` |
| same | accepted source bytes | `source.bytes.accepted:${sourceVersionId}` |
| `knowledge/search` | successful search | `search.executed:…` |

### Read APIs

| Path | Access |
|------|--------|
| `GET /masters/projectActivities/getOrganizationUsage` | `usage.view` + accessible projects |
| `GET /masters/projectActivities/getProjectUsage/:projectId` | `withProjectAccess('usage.view')` |
| `GET /masters/projectActivities/getMyUsage` | authenticated (caller userId only) |

Query: optional `from`, `to` (ISO UTC). Response omits zero total keys.

## 5. Schema

**Collection:** `projectActivities` / `ProjectActivity`

Kinds enum includes the six kinds above. Indexes: unique `{ orgId, dedupeKey }` partial A;
`{ orgId, projectId, occurredAt: -1 }` and `{ orgId, userId, occurredAt: -1 }` partial A.

## 6. Files

| Path | Role |
|------|------|
| `backend/src/models/projectActivity.model.js` | Schema + kinds |
| `backend/src/modules/masters/projectActivities.js` | record + aggregate + HTTP |
| `backend/src/modules/conversation/conversation.helper.js` | question/token on finalize |
| `backend/src/http/route.js` | route registration |
| `frontend/src/features/admin/AdminUsage.jsx` | admin UI |
| `frontend/src/features/admin/api/usageApi.js` | client |

## 7. Definition of Done

- [x] Usage recording at message, job, and search success paths
- [x] Token facts only when SDK reports usage
- [x] Three GET routes with correct permissions and accessible-project org scope
- [x] Admin FE with i18n, date range, honest empty/omit states
- [x] Dedupe prevents double count on retry
- [x] No estimated usage in API responses
