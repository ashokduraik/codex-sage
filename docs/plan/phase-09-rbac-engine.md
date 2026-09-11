# Phase 09 — RBAC engine & route authorization

- **Layer:** BE
- **Depends on:** Phase 07 (authenticated principal)
- **Unblocks:** Phase 10, 11, 12, 17 — and every protected route after them
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §6 (role-based access control), §88
  (security), §89 (data isolation), §90 (API authorization), §135 (administrative controls),
  §136 (admin operations are permission-protected); `frontend/requirments.md` §85 (role and
  permission UX, no internal identifiers), §105.31; `backend/solution.md` §8.2 (permission
  catalog), §8.4 (every handler: JWT → resolve org → RBAC); `docs/architecture.md` §3

## 1. Goal

After this phase the backend can answer "may this principal do this?" in one place. A
permission catalog module holds the exact permission strings from solution §8.2 with
human-readable labels, a resolver turns a user's role ids into an effective permission set, and
a `requirePermissions` `preHandler` factory guards any route with one line. Deny-by-default is
real: a route that declares no permission is refused at boot, not at runtime.

You can see it working by calling `GET /api/v1/auth/me` and getting the caller's effective
permissions back, then calling a guarded test route with a `viewer` token and getting `403`,
and calling it with a resource id from another organization and getting `404`.

## 2. Why this phase is here

Phase 07 established *who* the caller is; nothing yet limits *what* they may do, so every route
built before this phase would need retrofitting. Phases 10, 11 and 12 all guard their
endpoints with permissions, and Phase 17 onwards adds dozens of routes that each declare one.
Building the engine after those routes exist means auditing them all instead of writing them
correctly the first time.

It comes after Phase 07 because a permission check without a verified principal is meaningless,
and after Phase 06 because roles and memberships are what the resolver reads.

## 3. Scope

### In scope

- `permissionCatalog.ts`: the exact permission strings from solution §8.2, each with a group,
  a human-readable label and a description the UI renders (frontend §85).
- Effective-permission resolution: membership → roles → union of permission arrays.
- A role-permission cache with an explicit invalidation surface, and a documented staleness
  bound.
- `requirePermissions(...)`: a Fastify `preHandler` factory supporting "all of" and "any of".
- A route-declaration convention plus a boot-time assertion that every registered route either
  declares required permissions or is on an explicit public allowlist.
- Organization scope resolution: the rule that a tenant scope always comes from
  `request.principal.orgId`, never from a client-supplied parameter, and a helper that
  compares an organization path parameter to the principal's.
- The `403` versus `404` policy for cross-tenant resources.
- Extending `GET /api/v1/auth/me` with the caller's effective permissions.
- `GET /api/v1/permissions` so the Phase 15 role editor can render the catalog.
- A startup assertion that every permission stored on a Phase 06 role exists in the catalog.

### Out of scope (owner phase)

- Project-scoped authorization (`ProjectMember`, per-project overlays) — **Phase 18**. The
  factory here checks organization permissions only; Phase 18 adds a second `preHandler` that
  composes with it rather than replacing it.
- Audit events for denied requests — **Phase 10**. Leave the hook: the factory throws a typed
  `AuthorizationDenied` carrying `{ requiredPermissions, principalUserId, route, decision }`,
  and Phase 10 subscribes at the error handler rather than inside the factory.
- Rate limiting — **Phase 12**.
- Role and permission management endpoints (creating custom roles, assigning them) —
  **Phase 11**. This phase only reads roles.
- The permission-declaration audit across the whole route table — **Phase 61** repeats the boot
  assertion as an explicit review pass once every route exists.
- The role and permission UI — **Phase 15**.

## 4. Design

### 4.1 The catalog

`src/modules/authorization/permissionCatalog.js` exports a frozen array. It is the single
source of truth: role validation, the boot assertion and the UI all read it.

| Group | Permissions (solution §8.2) |
|---|---|
| Organization | `org.view`, `org.manage` |
| Users and roles | `users.manage`, `roles.manage` |
| Projects | `projects.create`, `projects.view`, `projects.update`, `projects.delete` |
| Sources | `sources.upload`, `repos.connect`, `sources.preview` |
| Knowledge | `knowledge.trigger`, `knowledge.view`, `knowledge.browse` |
| Chat | `chat.ask`, `conversations.view`, `conversations.archive`, `conversations.search` |
| Search | `search.run` |
| Administration | `settings.manage`, `audit.view`, `usage.view` |
| Notifications | `notifications.view` |

Twenty-three permissions, exactly the list in solution §8.2 — no additions. A capability that
needs a new permission adds it here in its own phase, and adding one to the catalog without
adding it to a role grants nothing, which is the safe direction.

Each entry carries `label` and `description` written in the voice of frontend §85 ("Can view
organization", "Can upload project sources", "Can trigger knowledge updates"). Frontend §85
also says internal permission identifiers must not be exposed. The interpretation here: the
`key` travels in API payloads as an opaque value the UI sends back when editing a role, but the
UI renders only `label` and `description` and never prints the key. Section 12 asks whether a
stronger reading is intended.

Permissions listed in backend §6 for the deferred customer-database slice (generate, execute
and view database queries) are deliberately absent — README §5 keeps that feature out of the
whole plan, and a permission for a feature that does not exist is a trap.

### 4.2 Resolving effective permissions

```text
principal.roleIds  →  active roles in principal.orgId  →  union(permissions[])
```

The role read is scoped by `orgId` in the query filter, so a tampered token carrying
role ids from another tenant resolves to an empty set rather than to those roles' permissions.

`org_admin` resolves to every catalog permission. Whether that is stored as an explicit array
or expanded from a wildcard is Phase 06's open question 4; this resolver handles both by
expanding a wildcard entry if one is present.

Unknown permission strings on a role are ignored rather than causing a request failure — a
role written by an older version of the code must not lock an organization out. The boot
assertion is what surfaces the drift, at deploy time, where it can be fixed.

### 4.3 Caching, and what deliberately is not cached

Two reads are involved per request and they have very different characteristics:

| Read | Changes | Cached? |
|---|---|---|
| Role id → permission array | Only when an administrator edits a role | Yes, in-process, TTL + explicit invalidation |
| User row and membership | On deactivation, password change, role assignment | No — Phase 07 already reads the user per request for exactly this reason |

Caching the role definitions is safe and worthwhile: they are few, small, and read on every
request. Caching the *user's* permission set is not, because a deactivated user or a
role-assignment change has to take effect immediately, and Phase 07's principal resolution
already pays for the user read.

The cache is a `Map` keyed by `${orgId}:${roleId}` with a named TTL constant, plus
`invalidateRole(orgId, roleId)` and `invalidateOrganization(orgId)` exported
for Phase 11 to call after a role write. Because the API may run as more than one process, a
local invalidation only clears the process that handled the write; other processes converge
within the TTL. That bound must be short and it must be written down — see section 12.

### 4.4 The preHandler factory and the declaration convention

```text
requirePermissions(['projects.create'])                    // caller must hold all listed
requirePermissions(['chat.ask', 'search.run'], 'any')      // caller must hold at least one
```

A route wires it in two places, and both are required:

```text
app.post('/projects', {
  config: { requiredPermissions: ['projects.create'] },
  preHandler: [authenticate, requirePermissions(['projects.create'])],
}, handler);
```

`config.requiredPermissions` is the declaration; the `preHandler` is the enforcement. The
declaration exists so that a boot-time assertion can walk Fastify's route table and fail
startup when a route has neither a declaration nor a place on the public allowlist
(`/health`, `/readiness`, `/auth/login`, `/auth/refresh`, `/auth/logout`). Deny-by-default is only real if forgetting
the guard is impossible, and a forgotten `preHandler` is otherwise invisible. Phase 61 repeats
this check as a review pass over the finished route table.

The factory itself does three things and nothing else: resolve the effective set, compare,
and throw `AuthorizationDenied` on a mismatch. It never reads the reply, never queries a
domain collection, and never inspects a path parameter.

### 4.5 Tenant scope, `403` and `404`

The scope rule is absolute: `orgId` comes from `request.principal`, which comes from a
verified token claim (backend §89, §90). No handler, service or repository may take it from a
path, query or body parameter. Where solution §8.4 exposes an organization in the path
(`GET /organizations/:orgId`), the parameter is compared to the principal's organization and a
mismatch is rejected — the parameter is validated, never trusted.

The status-code policy:

| Situation | Response |
|---|---|
| No or invalid token | `401 UNAUTHENTICATED` |
| Expired token, or invalidated by a password change | `401 SESSION_EXPIRED` |
| Valid principal, resource in their organization, permission missing | `403 FORBIDDEN` |
| Valid principal, resource belongs to another organization | `404 NOT_FOUND` |
| Valid principal, resource does not exist | `404 NOT_FOUND` |

The last two are identical on purpose. A `403` for a resource in another tenant confirms that
the id exists, which turns any endpoint into a cross-tenant existence oracle — backend §89
requires isolation at every layer, and that includes not leaking the shape of another
organization's data through status codes. Within the caller's own tenant a `403` is the honest
and more useful answer, because the resource genuinely exists and the UI can say so.

This falls out of the design rather than needing per-route care: repositories filter by
`orgId`, so a cross-tenant lookup returns `null` and the handler's ordinary
not-found path runs.

### 4.6 Ordering

`authenticate` must run before `requirePermissions`, and the permission check must run before
any tenant-scoped read. Phase 18 will insert a project-membership check after
`requirePermissions` and before the handler. The array order in `preHandler` is the contract:

```text
authenticate → requirePermissions → (Phase 18: requireProjectAccess) → handler
```

## 5. Data model changes

**None.** This phase reads the `roles` and `memberships` collections created in Phase 06 and
adds no collection and no field. The catalog is code, not data, because it is a property of
the deployed version rather than of a tenant.

## 6. API contract — PROPOSED (needs approval before implementation)

### `GET /api/v1/permissions`

- **Auth:** access token. **Permission:** `roles.manage` — only the role editor needs the full
  catalog, and it is the one surface that renders it (frontend §85).

Response `200`:

```json
{
  "groups": [
    {
      "id": "organization",
      "label": "Organization",
      "permissions": [
        { "key": "org.view", "label": "View organization", "description": "Can view organization details, users and roles." },
        { "key": "org.manage", "label": "Manage organization", "description": "Can change organization details and settings." }
      ]
    }
  ]
}
```

Every group in section 4.1 appears, in that order. `key` is carried so the UI can send it back
when saving a role; `label` and `description` are what the UI renders.

### `GET /api/v1/auth/me` — extended

The Phase 07 body gains one field:

```json
{
  "id": "6712f0b1c9a41d2f8e4b3a02",
  "email": "admin@acme.example",
  "displayName": "Acme Administrator",
  "orgId": "6712f0b1c9a41d2f8e4b3a01",
  "roleIds": ["6712f0b1c9a41d2f8e4b3a03"],
  "permissions": ["org.view", "users.manage", "projects.create"]
}
```

The frontend uses this to decide what to render. It is a convenience, not a control: backend
§90 and README §4 require every route to enforce independently, and hiding a button is not
security.

### Error bodies from the engine

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not have permission to perform this action." } }
```

The message never names the missing permission. Telling a caller which permission they lack
describes the authorization model to someone probing it, and the UI has the caller's own
permission list already. The required permissions are logged and, from Phase 10, audited.

## 7. Configuration & environment variables

**None.** No new `.env` keys. Cache TTL and capacity are named constants
(`.cursor/rules/env-config.mdc`).

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `RBAC_ROLE_CACHE_TTL_SECONDS` | `30` | `modules/authorization/roleCache.js` | In-process role-permission cache TTL; also the worst-case staleness after a role edit on another process |
| `RBAC_ROLE_CACHE_MAX_ENTRIES` | `500` | `modules/authorization/roleCache.js` | Upper bound on cached roles |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/authorization/permissionCatalog.js` | **New:** the 23 permissions, groups, labels, descriptions |
| `backend/src/modules/authorization/permissionCatalog.test.js` | **New:** completeness and uniqueness |
| `backend/src/modules/authorization/permissionResolver.js` | **New:** role ids → effective permission set |
| `backend/src/modules/authorization/permissionResolver.test.js` | **New** |
| `backend/src/modules/authorization/roleCache.js` | **New:** TTL cache with explicit invalidation |
| `backend/src/modules/authorization/roleCache.test.js` | **New** |
| `backend/src/modules/authorization/requirePermissions.js` | **New:** the preHandler factory |
| `backend/src/modules/authorization/requirePermissions.test.js` | **New** |
| `backend/src/modules/authorization/organizationScope.js` | **New:** compare an org path param to the principal |
| `backend/src/modules/authorization/organizationScope.test.js` | **New** |
| `backend/src/modules/authorization/routeDeclarationAudit.js` | **New:** boot assertion + public allowlist |
| `backend/src/modules/authorization/routeDeclarationAudit.test.js` | **New** |
| `backend/src/modules/authorization/permissions.routes.js` | **New:** `GET /permissions` |
| `backend/src/modules/authorization/permissions.routes.test.js` | **New** |
| `backend/src/modules/authorization/index.js` | **New:** public surface |
| `backend/src/modules/auth/auth.routes.js` | **Extend:** `/auth/me` returns `permissions` |
| `backend/src/modules/auth/auth.routes.test.js` | **Extend** |
| `backend/src/modules/identity/builtInRoles.js` | **Extend:** type the arrays against the catalog |
| `backend/src/modules/identity/adminPasswordReset.routes.js` | **Extend:** replace the Phase 08 inline check with `requirePermissions(['users.manage'])` |
| `backend/src/http/app.js` | Run the route-declaration assertion after routes are registered |
| `backend/src/http/routes.js` | Register `permissionsRoutes` |

## 9. Tests (≥ 80% line and branch)

### Unit

- The catalog contains exactly the 23 strings from solution §8.2 — asserted against a literal
  list in the test, so a silent addition fails.
- No duplicate key; every entry has a non-empty label and description; no label contains a dot
  or an internal key.
- The catalog contains no database-query permission (README §5).
- The resolver unions permissions across several roles and de-duplicates.
- The resolver returns an empty set for a user with no membership, and for role ids that
  resolve to no active role.
- The resolver ignores an unrecognised permission string on a role.
- `org_admin` resolves to every catalog permission.
- The cache returns a cached value inside the TTL, refetches after it, and drops the entry on
  `invalidateRole`; `invalidateOrganization` drops every role for that organization.
- The cache respects `RBAC_ROLE_CACHE_MAX_ENTRIES`.
- The boot assertion fails when a route has neither a declaration nor an allowlist entry, and
  passes when it has one.
- The organization-scope helper accepts a matching path parameter and rejects a differing one.

### Integration (`app.inject`, Phase 03 database harness)

- A guarded test route returns `200` for a caller holding the permission.
- The same route returns `403 FORBIDDEN` for a caller without it, with no permission name in
  the body.
- `any` mode passes when the caller holds one of two permissions.
- `GET /permissions` returns every group and requires `roles.manage`.
- `GET /auth/me` includes the caller's effective permissions and matches the resolver.
- A role edit followed by `invalidateRole` changes the decision on the next request.

### Negative-test matrix that must be covered

| Case | Expected |
|---|---|
| No `Authorization` header | `401 UNAUTHENTICATED` |
| Expired access token | `401 SESSION_EXPIRED` |
| Token signed with the wrong secret | `401 UNAUTHENTICATED` |
| Valid token, user set to `userStatus: 'disabled'` after issue | `401 UNAUTHENTICATED` |
| Valid token, user soft-deleted after issue | `401 UNAUTHENTICATED` |
| Valid token, missing permission | `403 FORBIDDEN` |
| Token with role ids belonging to another organization | `403 FORBIDDEN` (empty effective set) |
| Path parameter naming another organization | `404 NOT_FOUND` |
| Resource id from another organization on a guarded route | `404 NOT_FOUND`, identical body to a non-existent id |
| Route registered with no declaration | Startup fails |

## 10. Definition of Done

- [ ] The catalog holds exactly the solution §8.2 permission strings, each with a group, label
      and description, and no permission for an out-of-scope feature.
- [ ] Effective permissions resolve from role ids scoped to the principal's organization.
- [ ] Role permissions are cached with a named TTL constant and an explicit invalidation surface,
      and the staleness bound is documented.
- [ ] User status and membership are not cached, so deactivation takes effect on the next
      request.
- [ ] `requirePermissions` supports "all of" and "any of", and denies by default.
- [ ] Every registered route declares its required permissions or is on the public allowlist,
      enforced by a boot-time assertion.
- [ ] No code path derives `orgId` from a client-supplied parameter.
- [ ] Cross-tenant resources return `404` and are byte-identical to a non-existent resource;
      in-tenant permission failures return `403`.
- [ ] Error bodies never name the missing permission.
- [ ] A startup assertion verifies every permission stored on a role exists in the catalog.
- [ ] Phase 08's inline `users.manage` check is replaced by the shared factory.
- [ ] The denial path throws a typed error carrying the audit context Phase 10 needs.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/adr/`: record the cross-tenant `404` decision. It is a deliberate trade-off against
  debuggability and reviewers will question it, so it needs a written rationale and an escape
  hatch.
- `docs/architecture.md` §3: describe the fixed preHandler order and note that Phase 18 inserts
  the project check into it.
- `backend/solution.md` §8.2: no change expected — if the catalog here differs from §8.2 in any
  way, §8.2 is the source of truth and this phase is wrong.
- Add the permission table (group, label, description) to `docs/data-model.md` or a new
  `docs/permissions.md`, since Phase 15 builds its UI from it.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Cache staleness bound.** A role edit takes effect immediately on the process that handled
   it and within `RBAC_ROLE_CACHE_TTL_SECONDS` elsewhere. Is a bounded delay of tens of seconds
   for a *permission reduction* acceptable? If not, the options are a cache-busting version
   counter read per request (an extra Mongo read on every request) or a change-stream listener
   (new infrastructure). Thirty seconds is a placeholder, not a recommendation.
2. **How strictly should "do not expose internal permission identifiers" (frontend §85) be
   read?** The proposal keeps `key` in the payload as an opaque value and renders only
   `label` / `description`. If the requirement means the key must not reach the browser at
   all, the API needs a separate stable public id per permission and a mapping, which is more
   machinery for little gain.
3. **`403` versus `404` in practice.** The policy is stated, but support engineers will find
   `404` for a resource that visibly exists hard to diagnose. Is a correlation id in the
   response plus the real reason in the audit log (Phase 10) sufficient?
4. **Should `GET /permissions` require `roles.manage`?** It exposes no tenant data, only the
   product's capability vocabulary. A looser guard (any authenticated user) would let other UI
   surfaces render permission names, but it also describes the authorization model to anyone
   with an account.
5. **Wildcard for `org_admin`.** Depends on Phase 06 question 4. If the array is stored
   explicitly, adding a permission in a later phase silently fails to grant it to existing
   `org_admin` roles, which needs a schema/catalog update in whichever phase adds the permission.
6. **Deny-by-default at the framework level.** The boot assertion catches undeclared routes but
   still relies on the `preHandler` being wired. A global `onRequest` hook that reads
   `config.requiredPermissions` would make the two impossible to diverge. It is a bigger change
   to the request pipeline — worth doing now, or leave the two-place convention?
7. **`viewer` and `chat.ask`.** Solution §8.2 leaves it to policy. The answer belongs to Phase
   06's built-in role arrays but the negative tests here depend on it, so it must be settled by
   the time this phase is implemented.
8. **Permissions in the `/auth/me` payload** grow the response as roles grow. Acceptable, or
   should the UI fetch them separately and cache them?
