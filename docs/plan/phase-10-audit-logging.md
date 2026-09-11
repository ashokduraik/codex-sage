# Phase 10 — Audit logging

- **Layer:** BE
- **Depends on:** Phase 09 (RBAC engine, permission catalog, authenticated request context)
- **Unblocks:** Phase 11, 16, 17, 24, 30–32, 60 (audit retention), 61 (security hardening)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §86, §87, §90, §136, §148, §149, §150;
  `frontend/requirments.md` §87A, §105.35, §105.37; `backend/solution.md` §9.1–§9.3, §12.3;
  `docs/architecture.md` §10

## 1. Goal

After this phase the backend has an **append-only `AuditEvent` collection**, a **single writer
service** every other module calls to record a security-sensitive action, and a **tenant-scoped,
keyset-paginated `GET /api/v1/audit-events`** gated on `audit.view`. The identity actions built in
Phases 06–08 are retro-fitted to write audit events. You can see it working by running an admin
identity action, then listing `/api/v1/audit-events` and finding one row with the actor, action,
resource, result and the request's correlation id — and no credential anywhere in it.

## 2. Why this phase is here

Audit needs an authenticated actor, a resolved organization, and a permission (`audit.view`) to gate
the read API — none of which exist before Phase 09. It must land before Phase 11, where every admin
identity route must write an audit event (solution §8.4, "audit sensitive actions (§9)"), and before
Phases 17, 24 and 30–32, which audit project, source and repository actions from their first commit;
retro-fitting audit into dozens of merged routes later is the sweep this plan avoids. Phase 60 owns
expiry of audit rows (solution §12.3: 730 days, soft-delete only); Phase 61 verifies every sensitive
route actually calls the writer.

## 3. Scope

### In scope

- `AuditEvent` model with the exact field set from solution §9.1, plus its indexes.
- Append-only writer service with a stable typed API later phases call, a curated action catalog,
  and the context sanitizer enforcing the hard exclusion list (backend §87, §148; solution §9.1).
- Correlation-id linkage to the request id created in Phase 02.
- Retro-fit of the identity actions in solution §9.2 (user create/activate/deactivate, password
  reset, role and permission changes) built in Phases 06–08.
- `GET /api/v1/audit-events` with keyset pagination and `from`/`to`/`actor`/`action`/`resourceType`
  filters, always scoped to the caller's `orgId`.
- A decision (§4.4) on whether an audit write failure may fail the business action.

### Out of scope (owner phase)

- Audit events for projects, source, repositories, knowledge, chat and admin config — written by the
  phases that create those actions (17, 24, 28, 29, 30–32, 41, 60). This phase publishes only the
  writer API they call. Retention of audit rows is **Phase 60**, the audit admin UI **Phase 16**,
  the sweep proving every sensitive route audits **Phase 61**.
- Export, SIEM forwarding, cryptographic tamper-evidence (no phase owns these; see §12), and
  anything on the customer-database query path (README §5).

## 4. Design

### 4.1 Module, writer API and action catalog

New module `backend/src/modules/audit/` (`routes + service + repository + tests`, public surface in
`index.js`). Other modules import the writer from that surface only, never the model.

```text
recordAuditEvent({
  orgId, actorUserId?, action, resourceType, resourceId?,
  result: 'success' | 'denied' | 'failed',
  correlationId, ip?, userAgent?, context?
}) → Promise<void>
```

`buildAuditContextFromRequest(request)` extracts `orgId`, `actorUserId`, `correlationId`,
`ip` and `userAgent` from the authenticated request so handlers pass only the action-specific parts;
it returns data and never touches `reply`. `result` means: `success` = completed, `denied` = rejected
by authorization or a policy guard, `failed` = attempted and errored. A denied action is the most
valuable of the three and is never skipped because the request already returned `403`.

Free-text actions would make the §87A filter list unusable within a month, so `audit.actions.ts`
exports a typed union of `<domain>.<verb>` values with the `resourceType` each pairs with, seeded
with what this phase writes: `user.create`, `user.activate`, `user.deactivate`, `user.remove`,
`user.password_changed`, `user.password_set_by_admin`, `user.roles_changed`, `role.create`,
`role.update`, `membership.update`. Later phases extend the union in the change that
adds their route; adding a value is additive, renaming one breaks the audit UI.

### 4.2 Context sanitizer — the hard exclusion list

Solution §9.1 and backend §87, §148 are explicit: **never store** passwords, repository or database
credentials, authentication secrets, raw source bodies, full chat content, or query result rows —
store ids, counts, error codes and, where policy allows, paths. The sanitizer is an **allowlist**,
because a denylist fails the first time a caller invents a field name. `context` accepts string,
number, boolean, or arrays of those at depth 1 with no nested objects; keys matching a forbidden
substring (`password`, `token`, `secret`, `credential`, `authorization`, `apiKey`, `privateKey`,
`cookie`, `hash`) become `'[redacted]'` under the same key so a reviewer can see something was
removed; values cap at `AUDIT_CONTEXT_MAX_VALUE_CHARS` and the serialized object at
`AUDIT_CONTEXT_MAX_BYTES` (named constants in the sanitizer), truncating with `contextTruncated: true` rather than failing. This pure
function is the single control keeping backend §148 true for the trail, so it is exhaustively
unit-tested.

### 4.3 Append-only enforcement

No `PATCH`/`PUT`/`DELETE` route exists — absence is the primary control. The repository exposes
`insertAuditEvent` and `listAuditEvents` only, so there is no update or delete method to call by
mistake. Schema pre-hooks on `updateOne`, `findOneAndUpdate`, `updateMany`, `deleteOne`,
`deleteMany` and `findOneAndDelete` throw unless the query carries `{ retentionJob: true }`; Phase 60
is the only allowed caller and may only set `status: 'D'` (solution §9.1, §12.3).

### 4.4 May an audit write failure fail the business action?

**Decision: yes for state-changing admin and security actions; no for denial and read-access
events.** Backend §150 requires that all security-sensitive and administrative operations have
auditable records — a user silently created with no audit row breaks that, and the gap stays
invisible until an incident review needs it. Decision D5 supplies a replica set with multi-document
transactions, so for admin mutations (Phase 11) the audit insert joins the **same transaction**:
both commit or neither does, with no compensating-delete logic. For events not tied to a committing
write — `denied` authorization results, rate-limit rejections, read-access events — a failed insert
is logged at `error` with the correlation id and does not change the response; failing a denied
request harder helps nobody. Two entry points follow: `recordAuditEvent` (may throw, used inside the
caller's transaction) and `recordAuditEventBestEffort` (never throws, logs on failure). Each route's
phase document states which it uses; residual risk is in §12.

### 4.5 Correlation id and the list path

`correlationId` is **required**: a row that cannot be tied back to the request logs is half-useful,
and backend §105 makes that id the support handle. Worker-written events (Phases 25–32) reuse the
job's correlation id. On the list path, `orgId` comes from the authenticated request and is
injected at the repository boundary; a client-supplied organization filter is ignored, not honoured.
Sort is `createdAt` descending with `_id` as the tiebreak, the cursor is an opaque base64 of
`{ createdAt, _id }`, and an unparseable cursor is a `400`. Offset pagination is not offered — audit
grows without bound and `skip` degrades. `from` is inclusive, `to` exclusive, both ISO-8601 UTC.

## 5. Data model changes

New collection `auditevents`.

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId, required | Tenant scope; always filtered |
| `actorUserId` | ObjectId, optional | Absent for system/worker-initiated actions |
| `action` | string, required | From the `audit.actions.ts` catalog |
| `resourceType` | string, required | `user`, `role`, `membership`, … |
| `resourceId` | string, optional | Id of the affected resource |
| `result` | `'success' \| 'denied' \| 'failed'` | §4.1 |
| `correlationId` | string, required | Links to request/job logs (Phase 02) |
| `ip` / `userAgent` | string, optional | Source of action; `userAgent` truncated by the sanitizer constant |
| `context` | object, optional | Sanitized non-secret metadata (§4.2) |
| `createdAt` | Date, required, UTC | Set by the schema, never by the caller |
| `status` | `'A' \| 'D'`, default `'A'` | Row visibility; `'D'` only from Phase 60 |

Indexes: `{ orgId, status, createdAt: -1, _id: -1 }` (default list path);
`{ orgId, actorUserId, createdAt: -1 }`; `{ orgId, action, createdAt: -1 }`;
`{ orgId, resourceType, resourceId, createdAt: -1 }`. No TTL index — expiry is a
soft-delete policy owned by Phase 60, not a hard purge.

## 6. API contract — PROPOSED (needs approval before implementation)

### `GET /api/v1/audit-events`

- **Permission:** `audit.view`. **Auth:** JWT required.
- **Query (all optional):** `from`, `to`, `actor`, `action`, `resourceType`, `cursor`, `limit`.
- **Response `200`:**

```json
{
  "items": [
    {
      "id": "6650f1c2a4b1c9e0d3f21a77",
      "action": "user.deactivate",
      "resourceType": "user",
      "resourceId": "6650f0aa12cd34ef56ab7890",
      "result": "success",
      "actor": { "id": "6650efaa0011223344556677", "email": "admin@acme.test" },
      "correlationId": "01J9XQ2M6K7N8P9Q0R1S2T3U4V",
      "ip": "203.0.113.8",
      "userAgent": "Mozilla/5.0",
      "context": { "previousUserStatus": "active", "reason": "offboarding" },
      "createdAt": "2026-09-11T09:14:22.481Z"
    }
  ],
  "pageInfo": { "nextCursor": "eyJjIjoiMjAyNi0wOS0xMSIsImkiOiI2NjUwZjFjMiJ9", "hasMore": true }
}
```

- `actor` is resolved in one batched lookup (no N+1); a removed user still resolves, so history keeps
  its actor. **Errors:** `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `400 VALIDATION_ERROR` (bad cursor,
  bad date, unknown filter) in the existing `{ error: { code, message, details? } }` envelope.

### `GET /api/v1/audit-events/:auditEventId` — PROPOSED addition

Frontend §87A requires detail inspection; solution §9.3 lists only the list route. Same permission
and organization scope; `404 NOT_FOUND` when the row belongs to another organization (never `403`,
which would confirm it exists). Returns one item in the shape above (see §12). No write, update, or
delete endpoint is proposed — that is deliberate (§4.3).

## 7. Configuration & environment variables

**None.** No new `.env` keys. Size caps and page sizes are named constants
(`.cursor/rules/env-config.mdc`).

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `AUDIT_CONTEXT_MAX_BYTES` | `4096` | `modules/audit/audit.sanitizer.js` | Cap on the serialized `context` |
| `AUDIT_CONTEXT_MAX_VALUE_CHARS` | `512` | `modules/audit/audit.sanitizer.js` | Cap on a single context string |
| `AUDIT_USER_AGENT_MAX_CHARS` | `256` | `modules/audit/audit.sanitizer.js` | Truncation length for `userAgent` |
| `AUDIT_LIST_PAGE_SIZE_DEFAULT` | `50` | `modules/audit/audit.repository.js` | Default page size |
| `AUDIT_LIST_PAGE_SIZE_MAX` | `200` | `modules/audit/audit.repository.js` | Hard cap on `limit` |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/audit/audit.actions.js` | **New:** typed action / resourceType catalog |
| `backend/src/modules/audit/audit.model.js` (+ `.test.js`) | **New:** schema, indexes, append-only guards |
| `backend/src/modules/audit/audit.sanitizer.js` (+ `.test.js`) | **New:** allowlist, redaction, size caps |
| `backend/src/modules/audit/audit.repository.js` (+ `.test.js`) | **New:** insert + org-scoped keyset list |
| `backend/src/modules/audit/audit.service.js` (+ `.test.js`) | **New:** both writer entry points, list service |
| `backend/src/modules/audit/audit.routes.js` (+ `.test.js`) | **New:** `GET /audit-events` (+ detail if approved) |
| `backend/src/modules/audit/index.js` | **New:** public surface for other modules |
| `backend/src/http/routes.js` | Register `auditRoutes` alongside `healthRoutes` |
| `backend/src/modules/identity/*`, `backend/src/modules/auth/*` (Phases 06–08) | Add audit calls to identity and password-change / admin-set-password actions |
| `backend/src/test/appConfig.js` | Fixture stays as-is |

## 9. Tests (≥ 80% line and branch)

### Unit

- Sanitizer redacts `password`, `token`, `secret`, `credential` and `authorization` keys, rejects
  nested objects and functions, truncates over-long strings and sets `contextTruncated`.
- `recordAuditEvent` throws when `correlationId`, `action`, `resourceType` or `orgId` is
  missing; `recordAuditEventBestEffort` returns normally and logs at `error` when the insert rejects.
- Cursor encode/decode round-trips; a malformed cursor raises `VALIDATION_ERROR`; an unknown action
  string is rejected at runtime, not only by the type.

### Integration (Fastify `app.inject`, Mongo harness from Phase 03)

- `403` without `audit.view`, `401` without a token, and only the caller's organization's rows when
  two organizations have events.
- Keyset pagination across two pages: no duplicates, no gaps, `hasMore` false on the last page.
- Each of `from`, `to`, `actor`, `action`, `resourceType` narrows the result set; `limit` above
  `AUDIT_LIST_PAGE_SIZE_MAX` is clamped rather than rejected.
- A denied admin action produces one row with `result: 'denied'`; deactivating a user writes exactly
  one `user.deactivate` row carrying the request correlation id.
- A `status: 'D'` row never appears; `updateOne` / `deleteOne` without the retention option throws.

### Unhappy paths

- Audit insert fails inside an admin mutation → the action rolls back and the caller sees
  `500 INTERNAL_ERROR` (§4.4); on a `denied` event the `403` is returned unchanged.
- A serialization scan of stored rows and responses finds no password, reset token, or credential.

## 10. Definition of Done

- [ ] `AuditEvent` exists with exactly the solution §9.1 field set plus `status: 'A' | 'D'`.
- [ ] No client-facing route can update or delete an audit event, and schema guards prove it.
- [ ] Every Phase 06–08 identity action listed in solution §9.2 writes an audit event.
- [ ] `GET /api/v1/audit-events` enforces `audit.view`, scopes by organization, paginates by keyset,
      validates all five filters, and rejects unknown query parameters.
- [ ] The sanitizer blocks every item on the exclusion list, with a test naming each one.
- [ ] The §4.4 write-failure policy is implemented and both entry points are used deliberately.
- [ ] No new `.env` keys. Audit size caps and page sizes are constants.
- [ ] `npm run lint`, and `npm test` pass; coverage for every touched file is
      ≥ 80% line and ≥ 80% branch.
- [ ] No secret, credential, source body, or chat content appears in any row, log, or response.

## 11. Documentation & ADR updates

- `docs/architecture.md` §10: confirm the "Audit — append-only `AuditEvent`; no secrets, no raw
  source, no full chat" row matches what shipped; add the action-catalog convention.
- New ADR in `docs/adr/`: audit writes join the business transaction for admin mutations and are
  best-effort for denial and read events (§4.4), recording the always-best-effort alternative and a
  config escape hatch. Touch `backend/solution.md` §9 only if this phase contradicts it.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Write-failure policy** (§4.4) — confirm a failed audit insert may fail an admin mutation. The
   alternative trades §150 completeness for availability. Most consequential decision here.
2. **Detail endpoint** — approve `GET /api/v1/audit-events/:id`, or does Phase 16 render detail from
   the list payload only? Is the actor's email acceptable in responses, or only the actor id?
3. **Denied-request volume** — auditing every `403` makes the collection a cheap flood target until
   Phase 12 lands. Sample denied events, or restrict them to admin route classes?
4. **Tamper-evidence** — backend §150 says records "should be immutable according to the
   organization's policy"; application guards are not immutability. Later requirement, or explicitly
   out of scope?
5. **Paths in `context`** — solution §9.1 allows paths "when policy allows". Who sets that policy,
   and is it an organization setting or a constant?
6. **Scope check:** a new module, a list endpoint, and a retro-fit across Phases 06–08 sits at the
   top of the 1–2 day budget. If Phase 09 does not expose a clean request context, split the
   retro-fit into a follow-up.
