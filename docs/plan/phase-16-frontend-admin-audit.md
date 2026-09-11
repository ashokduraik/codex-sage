# Phase 16 — Frontend admin audit slice

- **Layer:** FE
- **Depends on:** Phase 10 (audit logging and `GET /audit-events`), Phase 14 (real session)
- **Unblocks:** Phase 59 and 60 (usage and retention reuse the same admin list, filter and
  keyset-pagination patterns)
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §87A (audit log UI), §88 (empty states),
  §90 (error states), §105.35 (secrets never redisplayed), §105.37 (admin surfaces show only
  backend-provided data), §107 (secret protection in the UI);
  `backend/requirments.md` §86, §87, §150; `backend/solution.md` §9

## 1. Goal

After this phase `AdminAudit.tsx` reads the organization audit trail from the real backend
instead of the in-memory mock. An authorized administrator can list audit events, filter them by
date range, actor, action and resource type, page through them with the backend's keyset cursor,
and expand one event to inspect the actor, action, target resource, timestamp and result that
the backend actually recorded.

You can see it working by performing an administrative action from Phase 15 — creating a user,
deactivating one — and finding exactly that event in the audit list with the real actor and
timestamp. Filtering to a date range that excludes it makes it disappear; no event, field or
count is ever rendered that the backend did not return.

## 2. Why this phase is here

Phase 15 is the first slice that writes audited actions, so audit becomes verifiable only once
those actions are real. It depends on Phase 10 for the event model and the read endpoint, and on
Phase 14 for the session and the caller's permissions (`audit.view`).

It is placed before the usage and retention screens because those three admin surfaces share the
same constraint — §105.37: show only backend-provided data — and this phase establishes the
pattern for keyset pagination and safe rendering of backend-supplied metadata.

## 3. Scope

### In scope

- React Query hook over `GET /api/v1/audit-events` with keyset pagination driven by the backend
  cursor.
- Filters: date range (from / to), actor, action, resource type (§87A, `solution.md` §9.3).
- Detail inspection for a single event showing actor, action, target resource, timestamp and
  result **when the backend provides them**.
- Safe rendering of event context: an allowlist of known non-secret keys only; never the raw
  payload object.
- Empty, loading and error states, including the authorization failure path for a caller
  without `audit.view`.
- Remove the audit mock-data usage from this feature.

### Out of scope (owner phase)

- Usage screen (`AdminUsage.tsx`) — **Phase 59**.
- Retention settings, including audit retention (`AdminRetention.tsx`) — **Phase 60**.
- Users and roles — **Phase 15**.
- Audit export (CSV/JSON download) — no endpoint exists; not invented here (section 12).
- Writing audit events from the frontend. Audit is backend-authored and append-only
  (`solution.md` §9.1); the UI only reads.
- Deleting `shared/mock-data/` — D7: it goes when nothing imports it.

## 4. Design

### 4.1 Hook and component split

```text
features/admin/
├── api/auditApi.ts        typed call over shared/api
├── api/useAuditEvents.ts  infinite query, cursor-driven
├── auditFieldPolicy.ts    what may be rendered from an event's context
├── AdminAudit.tsx         filters + list + detail disclosure
```

`AdminAudit.tsx` today holds the whole filter and expand state inline and filters an in-memory
array with `useMemo`. Filtering moves to the server, because the audit collection is unbounded
and client-side filtering of one page would silently lie about what matched.

### 4.2 Query, filters and keyset pagination

`solution.md` §9.3 defines
`GET /api/v1/audit-events?from&to&actor&action&resourceType&cursor`, requires `audit.view`, and
scopes every query to the caller's organization on the server. The frontend never sends an
organization scope and must not offer a control that implies cross-tenant access.

Pagination uses React Query's infinite query: `getNextPageParam` returns the backend's
`nextCursor`, and the "load more" control is disabled and shows an inline loader while the next
page is fetching. There is no page-number UI, because a keyset cursor cannot support one —
inventing page numbers would be a fabricated capability (§98).

Filter state lives in the URL query string and in the query key, so a filtered view is
shareable and survives a reload. Changing any filter resets the cursor chain. The actor and
resource-type filters are only offered in a form the backend accepts: if `actor` is a user id
rather than a free-text name, the control is a user picker, not a text box (section 12).

Timestamps are stored and compared in UTC and formatted at the presentation edge with the
existing `shared/lib/format.ts` helpers. The date-range filter sends UTC boundaries so a user in
a non-UTC timezone does not silently miss events at the edges of a day.

### 4.3 Result values

The mock uses `Success` / `Partial` / `Failed`. `solution.md` §9.1 defines
`result: success | denied | failed` — there is no partial. The filter chips and the result badge
are rebuilt from the backend's three values and localized through `en.json`; `Partial` is
removed. `denied` is meaningfully different from `failed` (an authorization refusal versus an
execution failure) and is presented as such, not merged into a single "error" tone.

An unrecognized result value is rendered verbatim with a neutral tone rather than being mapped
into a category the backend did not assert.

### 4.4 What must never be rendered

Frontend §107, §105.35 and `solution.md` §9.1 converge on the same rule: audit context carries
ids, counts, paths and error codes, and must never carry passwords, repository or database
credentials, tokens, raw source bodies, full chat content, or query result rows. The backend is
responsible for not storing them; the UI does not rely on that alone.

`auditFieldPolicy.ts` enforces a **render allowlist**: the event's top-level fields (actor,
action, resource type, resource id, timestamp, result, correlation id) plus a named set of
context keys the UI knows how to present. Anything else in `context` is not rendered — not as
JSON, not in a details block, not in a tooltip. The policy also rejects any value whose key
matches a secret-shaped pattern (token, secret, password, credential, key, authorization) even
if it appears on the allowlist, so a backend regression cannot leak through the UI.

`ip` and `userAgent` exist on the model. They are diagnostic rather than secret, but whether
they belong on screen is a product decision, not an implementation default — see section 12.

### 4.5 No fabrication

§105.37 forbids fabricating metrics or events on admin surfaces, and §87A says each detail shows
the listed fields "when provided by the backend". So:

- A field the response omits is omitted from the detail view, or labelled as not recorded — it
  is never filled with a placeholder that reads like data.
- No total count, no "N events" summary, and no time-bucketed chart unless the backend returns
  those numbers. A keyset-paginated list does not know its own total.
- The list never claims completeness beyond what was fetched; the end of the data is shown only
  when the backend reports no further cursor.

### 4.6 States

- **Loading:** a skeleton list sized like the rows it replaces, to avoid the layout jump
  frontend §89 warns about.
- **Empty:** distinguishes "no audit events yet" from "no events match these filters", and the
  second offers a clear-filters action (§88).
- **Error:** an inline `role="alert"` with the backend `error.message`, a localized fallback,
  the correlation ID when present, and a retry action (§90, §105.38).
- **Forbidden:** a `403` renders the authorization message and keeps the user signed in. The
  admin navigation entry is hidden for a caller without `audit.view`, but the `403` path is
  still implemented and tested — hiding a control is not a control.

### 4.7 Mock exports that stop being used

After this phase `features/admin/AdminAudit.tsx` no longer imports from `@/shared/mock-data`.
Specifically these stop being used **by this feature**:

- `useAppData()` field `audit`
- `AuditEntry` from `shared/types/domain.ts`, replaced by the API response type

`logAudit` on `useAppData()` is still called by the features that have not been rewired yet
(projects, chat, processing), so it stays for now; every one of its call sites disappears as
those slices are converted, and the mock module is deleted once nothing imports it (D7).
`SeedData.audit` in `shared/types/domain.ts` also stays until then.

## 5. Data model changes

**None.** Frontend-only phase; no collection, field or index changes. The audit collection and
its indexes are Phase 10's.

## 6. API contract — PROPOSED (needs approval before implementation)

Endpoint **consumed**, defined by Phase 10 (`solution.md` §9.3). This table records what this
slice needs; it defines no new endpoint.

### `GET /api/v1/audit-events`

- **Permission:** `audit.view`. Organization scope applied server-side, never sent by the client.
- **Query parameters sent:** `from`, `to`, `actor`, `action`, `resourceType`, `cursor`, `limit`.
- **Response needed:** an array of events plus `nextCursor` (absent or null at the end).

Per event, the fields this UI renders:

| Field | Rendered as | Notes |
|---|---|---|
| `actorUserId` (+ display name) | Actor | A raw id is not a name; see section 12 |
| `action` | Action | Localized where the frontend knows the value, verbatim otherwise |
| `resourceType`, `resourceId` | Target resource | |
| `createdAt` | Timestamp | UTC in, formatted at the edge |
| `result` | Result | `success` \| `denied` \| `failed` |
| `correlationId` | Reference | Shown in the detail view for support (§105.38) |
| `context` | Selected keys only | Render allowlist in §4.4 |

Frontend-visible contract details:

- Errors use `{ error: { code, message, details? } }`; codes distinguished by this slice:
  insufficient permission (`403`), invalid filter or cursor (`400`), rate limited (`429`).
- An invalid or expired cursor must be distinguishable so the UI can reset pagination instead of
  showing an empty list that looks like "no results".
- The response must never contain secrets, credentials, tokens, raw source bodies or chat
  content (`solution.md` §9.1, frontend §107). The UI enforces its own allowlist regardless.

## 7. Configuration & environment variables

**None.** This slice adds no variable; it reaches the backend through `shared/api` using
`VITE_API_BASE_URL` from Phase 13. Any future `.env.example` change must still be mirrored into
`.env` in the same change.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/admin/api/auditApi.ts` | **New:** typed `GET /audit-events` call |
| `frontend/src/features/admin/api/auditApi.test.ts` | **New:** parameter serialization, error mapping |
| `frontend/src/features/admin/api/useAuditEvents.ts` | **New:** infinite query driven by `nextCursor` |
| `frontend/src/features/admin/api/useAuditEvents.test.ts` | **New:** paging, filter-driven key changes, cursor reset |
| `frontend/src/features/admin/auditFieldPolicy.ts` | **New:** render allowlist + secret-shaped key rejection |
| `frontend/src/features/admin/auditFieldPolicy.test.ts` | **New:** allowed keys, rejected keys, nested payloads |
| `frontend/src/features/admin/AdminAudit.tsx` | **Rewrite:** real API, server filters, cursor paging, safe detail |
| `frontend/src/features/admin/AdminAudit.test.tsx` | **Rewrite:** list, filters, paging, detail, empty, loading, error, `403`, secret redaction |
| `frontend/src/shared/i18n/locales/en.json` | **Change:** result values, filter labels, date-range labels, empty/error copy, not-recorded label; remove the `Partial` audit result string |
| `frontend/src/shared/types/domain.ts` | **Change:** `AuditEntry` no longer describes the admin audit view once the API type lands |

## 9. Tests (≥ 80% line and branch)

`fetch` is mocked; component tests use `renderWithProviders`.

### Query and pagination

- The first page requests no cursor; "load more" sends the `nextCursor` from the previous page.
- The load-more control is hidden when the response returns no next cursor.
- Changing any filter resets the cursor chain and issues a fresh first-page request.
- The date range is sent as UTC boundaries.
- An invalid-cursor error resets pagination and shows the error rather than an empty list.

### Rendering and safety

- Each row shows actor, action, target resource, timestamp and result.
- A `denied` result is visually and textually distinct from `failed`.
- An event missing an optional field renders the not-recorded label, not a placeholder value.
- An event whose `context` contains `token`, `password`, `secret` or `credential` keys renders
  none of those keys or values anywhere in the output (asserted directly on the DOM).
- A context key outside the allowlist is not rendered, even though the response contains it.
- The correlation ID is shown in the detail view when present and omitted when absent.
- No total-count or summary metric is rendered anywhere.

### States

- Loading skeleton renders before the first page resolves.
- The no-events-yet empty state and the no-match empty state are distinct; the second offers a
  clear-filters action that resets the query.
- A list failure renders `role="alert"` with the backend message plus a retry action.
- An unparseable error body renders the localized fallback, never a raw transport string.
- A `403` renders the authorization message and the user remains signed in.
- Renders without horizontal scroll at 375 px, 768 px and 1280 px; rows stack on mobile.

## 10. Definition of Done

- [ ] `AdminAudit.tsx` contains no import from `@/shared/mock-data`.
- [ ] All filtering and pagination happen on the server; no client-side filter over a page.
- [ ] `auditFieldPolicy.ts` is the only path by which event context reaches the DOM, and a test
      proves a secret-shaped key is never rendered.
- [ ] No count, metric, chart or event is displayed that the backend did not return.
- [ ] Result values match the backend's `success` / `denied` / `failed`; `Partial` is gone from
      the code and from `en.json`.
- [ ] Empty, loading, error and forbidden states all render and are covered by tests.
- [ ] No user-facing string is hardcoded; all copy comes from `en.json`.
- [ ] The screen renders without horizontal scroll at 375 px, 768 px and 1280 px.
- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass in `frontend/`.
- [ ] Coverage for every file this phase touched is ≥ 80% line and ≥ 80% branch.

## 11. Documentation & ADR updates

- No ADR is expected; this slice consumes Phase 10's decisions rather than making new ones.
- `docs/architecture.md` §10 lists audit as append-only with no secrets — confirm the wording
  still matches what the UI renders; adjust only if this phase contradicts it.
- Do not edit `docs/plan/README.md` or another phase document from this phase.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Actor display.** `AuditEvent` stores `actorUserId`. Does the endpoint expand it to a name
   and email, or must the UI resolve ids against `GET /users`? Rendering a raw id is a poor
   experience, and resolving ids client-side is an N+1 and needs `users.manage`, which an
   `audit.view` caller may not have. Blocking for the actor column.
2. **Actor filter shape.** Is `actor` a user id, an email, or free text? The control differs.
3. **Action and resource-type vocabularies.** Is there an enumerated list the UI can offer as a
   select, or is the filter free text? Free text guarantees empty results from typos.
4. **`ip` and `userAgent`.** Show them in the detail view or not? They are recorded but §87A
   does not list them, and showing them has privacy implications.
5. **System-initiated events.** What is rendered as the actor when `actorUserId` is absent (a
   retention job, a scheduled sync)? Proposal: a localized "system" label, confirmed rather
   than assumed.
6. **Export.** §150 mentions enterprise audit requirements. Is an export needed in this slice?
   No endpoint exists, so it is excluded here rather than invented.
7. **Default date range.** Unbounded (the backend's default page) or a sensible recent window?
   A default window changes what an administrator believes they are looking at, so it must be
   stated on screen if one is applied.
