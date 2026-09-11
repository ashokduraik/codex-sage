# Phase 18 — Project membership & project-scoped authorization

- **Layer:** BE
- **Depends on:** Phase 17 (project model)
- **Unblocks:** Phase 19, 23, 24, 30, 37, 38, 41, 50 (every project-scoped route)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §8 (project access), §6 (RBAC), §89 (data
  isolation), §90 (API authorization), §114 (project-scoped answers), §115 (cross-project
  access), §88 (security), §86–§87 (audit);
  `backend/solution.md` §8.1 (`ProjectMember`), §8.2 (permission catalog), §8.4 (members API),
  §9.2 (audited actions); `docs/architecture.md` §3 (scoping), §8 (same isolation for search)

## 1. Goal

After this phase a project has an **access list**, and the backend can answer one question
authoritatively for any request: *may this user perform this permission on this project?*
The answer combines the caller's organization role permissions (Phase 09) with a
per-project overlay, and it is enforced by a reusable `requireProjectPermission` preHandler
that every project-scoped route from Phase 19 onward must use.

You can see it working by giving a user `projects.view` at the organization level but no access
to project X: `GET /api/v1/projects/X` returns `404`, while a project member with the same role
gets `200`. A user of organization A gets `404` for every project of organization B, whatever
they send in the request.

## 2. Why this phase is here

Phase 17 created project routes guarded only by organization-level permissions. Backend §8
requires access to be *independently controllable* per project, and §114/§115 make
cross-project leakage a product-level failure, not a hardening detail. Doing this before any
project content exists means the guard is the default from the first content route rather than
a retrofit across dozens of handlers.

It cannot come earlier: there is no project to scope to before Phase 17. It must not come later:
Phase 19 renders projects lists and Phase 23 onward writes project-scoped content — both need
the guard already in place. Phase 61 (security hardening) re-audits this work end to end, it
does not replace it.

## 3. Scope

### In scope

- `ProjectMember` model from solution §8.1 with row `status: 'A' | 'D'`.
- The three access shapes of backend §8: all organization projects, selected projects, none.
- `resolveProjectPermissions(orgId, userId, projectId)` — the single source of truth.
- `requireProjectPermission(permission)` Fastify preHandler + a `projectScope` request
  decoration that repositories consume.
- Retrofitting Phase 17's project routes onto the guard.
- Members API: `GET`, `POST`, `DELETE /projects/:projectId/members` (solution §8.4).
- Audit events for member add and member removal.
- A negative-test matrix proving cross-organization and cross-project isolation.
- Cache and invalidation sharing the mechanism introduced in Phase 09.

### Out of scope (owner phase)

- Organization roles, the permission catalog and the org-level preHandler — **Phase 09**.
- The audit writer itself — **Phase 10**.
- Admin users/roles/membership APIs — **Phase 11**.
- Frontend member management UI — not in this plan's project slice; Phase 19 only consumes the
  access decision, and there is no members screen until one is requested.
- Conversation privacy (own conversations vs project members) — **Phase 41**.
- The repeat isolation audit across every route — **Phase 61**.

## 4. Design

### 4.1 Where each access shape lives

Backend §8 describes access at the user level, so the "all projects" and "none" shapes cannot be
expressed by rows in a per-project collection. They belong to the organization membership
created in Phase 06:

| Shape (backend §8) | Representation |
|---|---|
| All organization projects | `Membership.projectAccessMode = 'all'` |
| Selected projects | `Membership.projectAccessMode = 'selected'` + one `ProjectMember` row per project |
| No projects | `Membership.projectAccessMode = 'none'` |

`projectAccessMode` is a **new field on the existing `memberships` collection** (see section 5
and open question 1), defaulting to `selected` so a new user starts with no project visibility
until granted.

### 4.2 Effective permission resolution

```text
resolveProjectPermissions(orgId, userId, projectId):
  1  load the project           → not found / status 'D' / other org  → NO_ACCESS
  2  load the membership        → missing or userStatus != active     → NO_ACCESS
  3  orgPermissions = union(permissions of membership.roleIds)        (Phase 09)
  4  switch membership.projectAccessMode
       'none'      → NO_ACCESS
       'all'       → visible = true,  overlay = optional ProjectMember row
       'selected'  → load ProjectMember; missing → NO_ACCESS; else visible = true
  5  overlayPermissions = member.permissions ∪ permissions(member.roleId)
  6  effective = orgPermissions ∪ overlayPermissions
  7  return { visible: true, permissions: effective }
```

Three deliberate rules:

- **The overlay only grants.** A `ProjectMember` row cannot remove a permission the
  organization role already gives. Deny rules are not in solution §8.2 and are not invented
  here (open question 2).
- **Visibility comes first.** `projectAccessMode` and the membership row decide *whether the
  project exists for this caller*; permissions decide *what they may do with it*.
- **Permission names are exactly solution §8.2.** No new permission string is introduced by this
  phase.

### 4.3 The guard, and why it returns 404

```text
requireProjectPermission('projects.update')
  → authenticate (Phase 07) → orgId, userId
  → read :projectId from params; reject a non-ObjectId with 400
  → resolveProjectPermissions(...)
       NO_ACCESS                      → 404 PROJECT_NOT_FOUND
       visible, permission missing    → 403 FORBIDDEN
       visible, permission present    → decorate request.projectScope and continue
```

`404` for an inaccessible project is the isolation requirement, not politeness: `403` would
confirm that the project exists, which backend §114/§115 forbid across tenants and projects.
`403` is only used once the caller can already see the project, which is information they
legitimately have.

`request.projectScope = { orgId, projectId, userId, permissions }` is the **only**
scope a repository may trust. Repository functions keep taking `orgId` and
`projectId` as explicit arguments (Phase 17 §4.7) — the decoration is what routes read them
from, so no handler reconstructs a filter from raw request input.

### 4.4 Retrofitting Phase 17

Phase 17's routes move from the org-only preHandler to `requireProjectPermission`:

| Route | Permission |
|---|---|
| `GET /projects/:projectId` | `projects.view` |
| `PATCH /projects/:projectId` | `projects.update` |
| `GET`/`PATCH /projects/:projectId/settings` | `settings.manage` |
| `POST /projects/:projectId/archive`, `/restore` | `projects.update` |
| `GET /projects/:projectId/deletion-preview`, `DELETE /projects/:projectId` | `projects.delete` |
| `GET`/`POST`/`DELETE /projects/:projectId/members` | see open question 3 |

`GET /projects` (the list) cannot use a per-project preHandler. Instead the repository takes an
**accessible-project filter** built from the same resolver: `projectAccessMode: 'all'` means no
extra clause, `selected` means `_id ∈ activeProjectMemberIds(userId)`, `none` means an empty
result. The id set is fetched once per request with a projection on `projectId`, keeping the
list query a single indexed lookup rather than an N+1 per row.

`POST /projects` stays organization-scoped (`projects.create`), and the creator is inserted as a
`ProjectMember` in the same operation so the person who creates a project can always see it.

### 4.5 Caching and invalidation

Resolution touches three documents, and Phase 50's chat path will call it on every message, so
it is cached using the mechanism Phase 09 introduced for organization permissions:

- **Per-request memo** keyed `orgId:userId:projectId`, always used.
- **Process-local LRU** with a short TTL (`PROJECT_ACL_CACHE_TTL_MS`), keyed the same way, with
  the value carrying the `aclVersion` it was computed from.
- **`aclVersion`** is an integer on the organization document, incremented whenever a role's
  permissions, a membership, a `projectAccessMode` or a `ProjectMember` row changes. A cached
  entry whose `aclVersion` is stale is discarded on read, so a permission revocation takes
  effect on the next request rather than after the TTL — important because this is a security
  boundary, and because the API runs as more than one process (`docs/architecture.md` §2) and
  cannot rely on local eviction alone.
- Caching is **disabled in tests** (`nodeEnv === 'test'`) so authorization tests never pass on stale state.

### 4.6 Members API behaviour

- `POST` is idempotent on `{ projectId, userId }`: re-adding an existing active member returns
  `200` with the current row instead of creating a duplicate. Re-adding a previously removed
  member reactivates the same row (`status: 'D'` → `'A'`).
- `DELETE` is a soft delete (`status: 'D'`) per README §4, so the access history is not lost.
- Removing the last member is allowed — organization admins with `projectAccessMode: 'all'`
  retain access, and a project with no members is still administrable.
- A `userId` from another organization is rejected with `404 USER_NOT_FOUND`, not `400`, so the
  API does not confirm the existence of foreign users.
- Both mutations write an `AuditEvent` (solution §9.2 "role/permission changes") with the actor,
  the target user id, the project id and the resulting permission set — never the user's email
  or any token.

## 5. Data model changes

New collection `project_members`.

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | Tenant key, required |
| `projectId` | ObjectId | Required |
| `userId` | ObjectId | Required |
| `roleId` | ObjectId \| null | Optional project-level role (solution §8.1) |
| `permissions` | string[] | Explicit overlay grants from the §8.2 catalog only |
| `addedByUserId` | ObjectId | Actor who granted access |
| `createdAt` / `updatedAt` | Date (UTC) | |
| `status` | `'A' \| 'D'` | default `'A'` (README §4) |

Indexes:

- `{ orgId: 1, projectId: 1, userId: 1 }` unique, partial `status: 'A'`.
- `{ orgId: 1, userId: 1 }` partial `status: 'A'` — the accessible-project filter.
- `{ orgId: 1, projectId: 1, createdAt: -1, _id: -1 }` partial `status: 'A'` — member
  list keyset.

Changed collection `memberships` (created in Phase 06): add
`projectAccessMode: 'all' | 'selected' | 'none'`, required, default `'selected'`.

Changed collection `organizations`: add `aclVersion: number`, default `0`, incremented by the
invalidation hook in §4.5. Both schema changes (plus indexes on `project_members`) are declared
on the Mongoose models and synced via Phase 03 `syncSchemaIndexes`. Bootstrap / tests set
`projectAccessMode` on new memberships; existing local docs are updated when re-synced or
re-seeded (no versioned migration pre–go-live).

## 6. API contract — PROPOSED (needs approval before implementation)

All paths under `/api/v1`. Errors use `{ error: { code, message, details? } }`.

### `GET /projects/:projectId/members?limit=20&cursor=…`

```json
{
  "items": [
    {
      "id": "6651a0010000000000000011",
      "userId": "6650f0aa0000000000000001",
      "roleId": null,
      "permissions": ["projects.view", "chat.ask", "knowledge.view"],
      "addedByUserId": "6650f0aa0000000000000009",
      "createdAt": "2026-09-11T09:12:04.000Z"
    }
  ],
  "nextCursor": null
}
```

The response carries ids only. Names and emails are resolved by the admin identity APIs from
Phase 11 — this endpoint does not join user documents.

### `POST /projects/:projectId/members`

```json
{ "userId": "6650f0aa0000000000000001", "permissions": ["projects.view", "chat.ask"] }
```

or

```json
{ "userId": "6650f0aa0000000000000001", "roleId": "6650f0bb0000000000000002" }
```

`201` on create, `200` when the member already existed, returning the member shape above.

Errors: `400 VALIDATION_ERROR` (neither `roleId` nor `permissions`, or a permission outside the
§8.2 catalog), `403 FORBIDDEN`, `404 PROJECT_NOT_FOUND`, `404 USER_NOT_FOUND`,
`404 ROLE_NOT_FOUND`.

### `DELETE /projects/:projectId/members/:userId`

`204`, no body. Repeating it returns `404 MEMBER_NOT_FOUND`.

> Solution §8.4 writes this as `DELETE /projects/:id/members`. The path above puts the target in
> the URL instead of the body, which is the REST convention required by
> `.cursor/rules/backend-api-standards.mdc` — confirm before implementing (open question 4).

### Effect on Phase 17 responses

No response body changes. Only the status codes change: an inaccessible project now returns
`404 PROJECT_NOT_FOUND` and a visible project without the permission returns `403 FORBIDDEN`.

## 7. Configuration & environment variables

**None.** No new `.env` keys. Cache TTL and capacity are named constants
(`.cursor/rules/env-config.mdc`). Tests disable the LRU when `nodeEnv === 'test'`.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `PROJECT_ACL_CACHE_TTL_MS` | `5000` | `modules/projectMembers/projectAccess.js` | TTL for the resolved-permission LRU |
| `PROJECT_ACL_CACHE_MAX_ENTRIES` | `5000` | `modules/projectMembers/projectAccess.js` | LRU capacity |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/projectMembers/projectMembers.model.js` | **New:** `ProjectMember` schema + indexes |
| `backend/src/modules/projectMembers/projectMembers.repository.js` | **New:** scoped queries, accessible-project ids |
| `backend/src/modules/projectMembers/projectMembers.repository.test.js` | **New:** scoping, reactivation, keyset |
| `backend/src/modules/projectMembers/projectMembers.service.js` | **New:** add/remove, audit, cache invalidation |
| `backend/src/modules/projectMembers/projectMembers.service.test.js` | **New:** idempotent add, soft remove |
| `backend/src/modules/projectMembers/projectMembers.routes.js` | **New:** members endpoints |
| `backend/src/modules/projectMembers/projectMembers.routes.test.js` | **New:** integration tests |
| `backend/src/modules/projectMembers/projectAccess.js` | **New:** `resolveProjectPermissions` + cache |
| `backend/src/modules/projectMembers/projectAccess.test.js` | **New:** the full resolution matrix |
| `backend/src/modules/projectMembers/index.js` | **New:** public surface (resolver + guard + service) |
| `backend/src/http/preHandlers/requireProjectPermission.js` | **New:** Fastify preHandler + `projectScope` |
| `backend/src/http/preHandlers/requireProjectPermission.test.js` | **New:** 400/403/404 branches |
| `backend/src/modules/projects/projects.routes.js` | Attach the guard to every `:projectId` route |
| `backend/src/modules/projects/projects.routes.test.js` | Extend with access-denied cases |
| `backend/src/modules/projects/projects.repository.js` | Apply the accessible-project filter in list |
| `backend/src/modules/projects/projects.service.js` | Insert the creator as a `ProjectMember` |
| `backend/src/http/routes.js` | Register `projectMemberRoutes` |
| `backend/src/modules/identity/` models | **Change:** add `projectAccessMode` on memberships; `aclVersion` on organizations |

## 9. Tests (≥ 80% line and branch)

### Unit — `resolveProjectPermissions` matrix

| Case | Expected |
|---|---|
| `projectAccessMode: 'all'`, no member row | visible, org permissions only |
| `'all'` + member row with extra permissions | visible, union of both |
| `'selected'` + member row | visible, union |
| `'selected'`, no member row | `NO_ACCESS` |
| `'none'`, member row present | `NO_ACCESS` (mode wins) |
| Member row `status: 'D'` | `NO_ACCESS` |
| Project `status: 'D'` | `NO_ACCESS` |
| Project in another organization | `NO_ACCESS` |
| Membership missing or user not active | `NO_ACCESS` |
| Overlay tries to remove an org permission | ignored; permission stays |
| Overlay `roleId` pointing at another org's role | `ROLE_NOT_FOUND`, no permissions granted |

Plus: a cached entry with a stale `aclVersion` is recomputed; the cache is bypassed when
disabled; the per-request memo is used for repeated calls in one request.

### Integration

- Member add → the user can `GET` the project; member remove → the same call returns `404`.
- Adding the same member twice yields one active row and `200` on the second call.
- Removing then re-adding reactivates the original row id.
- `GET /projects` returns only accessible projects for `selected`, all for `all`, none for
  `none`, and paginates correctly in each case.
- The project creator is a member immediately after `POST /projects`.
- `AuditEvent` rows exist for add and remove with actor, target and project.
- Revoking access invalidates the cache: the next request is denied without waiting for the TTL.

### Negative matrix that must be covered (backend §114, §115)

| Attempt | Expected |
|---|---|
| User of org A reads a project of org B | `404 PROJECT_NOT_FOUND` |
| User of org A adds a member to a project of org B | `404 PROJECT_NOT_FOUND` |
| User of org A adds a user of org B to their own project | `404 USER_NOT_FOUND` |
| Org member with `projects.view` but no project access | `404`, not `403` |
| Project member with `projects.view` calling `PATCH` | `403 FORBIDDEN` |
| Request carrying `orgId` of org B in body or query | ignored; JWT org wins |
| Request with a valid token for a deactivated user | `401`/`403`, never data |
| `:projectId` that is not an ObjectId | `400 VALIDATION_ERROR`, no database hit |

## 10. Definition of Done

- [ ] `ProjectMember` exists with row `status`, the unique partial index, and no hard delete.
- [ ] The three access shapes of backend §8 are all representable and all tested.
- [ ] `resolveProjectPermissions` is the only place that decides project access; no route or
      repository re-implements any part of it.
- [ ] `requireProjectPermission` is attached to every `:projectId` route created in Phase 17.
- [ ] Inaccessible projects return `404`; visible-but-unauthorized returns `403`; both are
      asserted in tests.
- [ ] `GET /projects` is filtered by accessible projects with a single indexed lookup (no N+1).
- [ ] Members add/remove are audited and never log or return emails, tokens or passwords.
- [ ] Permission revocation takes effect on the next request via `aclVersion`, not after a TTL.
- [ ] Every permission string used comes from solution §8.2 — no new names.
- [ ] `npm run lint` and `npm test` pass in `backend/` with ≥ 80% line and
      branch coverage on the touched files.
- [ ] A one-page note in the phase PR lists which routes later phases must guard, so Phase 23
      onward cannot forget.

## 11. Documentation & ADR updates

- `docs/architecture.md` §3: confirm "RBAC + project membership on every protected route"
  matches the guard and the `404`-over-`403` decision.
- Record the **404-for-inaccessible-resources** decision as an ADR in `docs/adr/` — it affects
  every future route and reviewers will otherwise re-litigate it per pull request.
- Record an ADR for the `aclVersion` invalidation scheme if Phase 09 did not already write one
  for organization permissions; otherwise extend that ADR's consequences by superseding it.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Where does `projectAccessMode` belong?** Proposed: on `Membership`. Alternatives: on the
   `Role` (so `org_admin` implies `all`), or a separate policy document. Confirm before the
   schema change, because it changes Phase 06's model.
2. **Deny overlays.** Should a `ProjectMember` row ever be able to *remove* a permission granted
   by the organization role (for example, an org member who must not ask questions in one
   sensitive project)? Proposed: no, grants only.
3. **Who may manage members?** Proposed: `projects.update` on that project, or org-level
   `users.manage`. Solution §8.2 has no dedicated `members.manage` permission — confirm rather
   than inventing one.
4. **Members delete path.** Confirm `DELETE /projects/:projectId/members/:userId` instead of
   solution §8.4's body-based `DELETE /projects/:id/members`.
5. **`org_admin` implicit access.** Does `org_admin` always see every project regardless of
   `projectAccessMode`, or must it also be `all`? Proposed: it is granted `all` by the Phase 06
   seed, so no special case exists in the resolver.
6. **Multi-process cache.** `aclVersion` requires one extra organization read per resolution
   unless that document is itself cached. Is an occasional stale read of `aclVersion` acceptable,
   or should the ACL cache be disabled until a shared cache exists? Redis is out of scope
   (README §5).
7. **Scope creep check.** If open questions 1 and 3 turn into schema changes on `memberships`
   plus a new permission, this phase grows past two days; the membership-schema part should then
   move into Phase 11's follow-up rather than expanding here.
