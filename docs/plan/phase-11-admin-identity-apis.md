# Phase 11 — Admin identity APIs: users, roles, memberships

- **Layer:** BE
- **Depends on:** Phase 09 (RBAC engine, permission catalog, route guard), Phase 10 (audit writer)
- **Unblocks:** Phase 15 (frontend admin users & roles), Phase 18 (project ACL reuses the
  membership service), Phase 61 (security hardening sweep)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §5 (user management), §6 (RBAC), §89 (data
  isolation), §135 (administrative controls), §136 (admin operations are permission-protected
  and auditable), §147, §148; `backend/solution.md` §8.1, §8.2, §8.4, §9.2;
  `docs/architecture.md` §10

## 1. Goal

After this phase an organization administrator can run the whole identity lifecycle over HTTP:
create a user, list and inspect users, change a user's details and roles, activate, deactivate,
soft-remove, trigger an administrator-initiated password reset, and list, create and update
roles. Every route is permission-gated by the Phase 09 guard, scoped to the caller's
organization at the repository boundary, and writes an audit event through the Phase 10 writer.

You can see it working by signing in as the seeded `org_admin`, creating a user, listing
`/api/v1/users` and paging through with the returned cursor, deactivating that user, and then
finding the matching `user.create` and `user.deactivate` rows in `/api/v1/audit-events` — with
no password hash, reset token, or other secret anywhere in any response.

## 2. Why this phase is here

Phase 06 created the identity collections and their repositories but deliberately added no HTTP
route. Phase 09 supplies the permission catalog and the route guard that every one of these
routes needs, and Phase 10 supplies the writer that §136 requires ("administrative operations
must be permission-protected and auditable"). All three must exist first, and none of them can
be demonstrated end to end until routes like these exist.

It cannot come later: Phase 15 is the frontend admin slice, and today the only way to create a
second user is to hand-edit the database. Decision D6 removed self-registration, so these
endpoints are the only supported path from one seeded administrator to a working organization.

## 3. Scope

### In scope

- `POST`, `GET`, `PATCH` for users; activate, deactivate, soft-remove, admin reset-password
  trigger; `GET`/`POST`/`PATCH` for roles; role assignment on the organization membership.
- Keyset pagination and filtering on both list endpoints.
- Service layer over the Phase 06 repositories, with validation, conflict handling, and the
  safety guards in §4.4 (last administrator, self-deactivation, built-in role edits).
- An audit event for every mutating route, inside the same transaction as the write (Phase 10
  §4.6, decision D5).
- Response mappers that guarantee `passwordHash` and every reset artefact are unreachable.

### Out of scope (owner phase)

- Reset-token generation, hashing, expiry and the user-facing confirm endpoint — **Phase 08**.
  This phase calls the Phase 08 service and returns its non-secret status.
- `ProjectMember` and project-level access assignment — **Phase 18**. Frontend §83 asks for
  project access at user-create time; that field is **not** invented here (§12, question 1).
- Organization create / update endpoints from solution §8.4 — no phase owns them yet (§12).
- `Idempotency-Key` handling on admin creates — **Phase 12**, which retro-fits the middleware
  onto `POST /users` and `POST /roles`.
- Rate limiting of the admin-mutate class — **Phase 12**.
- Retention, usage and audit admin routes — **Phases 59, 60** and **Phase 10**.
- Any database-query permission as a live feature (README §5): those catalog entries do not
  exist and must not be creatable on a custom role.

## 4. Design

### 4.1 Module layout

Everything lands in the existing `src/modules/identity/` module from Phase 06, which already
owns the four models and their repositories. Routes and services are new files; nothing outside
the module imports a repository directly.

```text
identity.routes.ts     route registration, schemas, permission decorations
identity.schemas.ts    zod request/response schemas shared by routes and tests
user.service.ts        create, list, get, update, activate, deactivate, remove, reset trigger
role.service.ts        list, create, update
membership.service.ts  role assignment for a user inside the organization
identity.mappers.ts    document → DTO; the only place a user becomes a response body
```

Handlers own `reply`; services return data or throw typed errors
(`.cursor/rules/function-design.mdc`). Services take the authenticated request context
(`organizationId`, `actorUserId`, `correlationId`) as an argument rather than reading a request.

### 4.2 Permission gating

Every route declares its required permission from the Phase 09 catalog and is enforced by the
guard, never by an ad-hoc check in the handler:

| Routes | Permission |
|---|---|
| User list, detail | `users.manage` |
| User create, update, activate, deactivate, remove, reset trigger | `users.manage` |
| Role list | `roles.manage` |
| Role create, update | `roles.manage` |
| Role assignment on a user | `users.manage` **and** `roles.manage` |

Whether reading the user list should be possible with a weaker permission (`org.view`) is open
(§12, question 3). Backend §6 is explicit that enforcement never depends on what the UI shows,
so a hidden control in Phase 15 still produces a `403` here.

### 4.3 Tenancy, soft delete and pagination

- `organizationId` always comes from the authenticated request context and is injected at the
  repository boundary. A client-supplied organization value is rejected by the schema, not
  ignored silently.
- A resource belonging to another organization returns `404 NOT_FOUND`, never `403` — a `403`
  confirms the id exists.
- Remove is `status: 'D'` only (`.cursor/rules/soft-delete.mdc`). No route hard-deletes. The
  removed user's membership row is tombstoned in the same transaction so a stale membership
  cannot grant access; their audit history is untouched.
- Lists are keyset-paginated on `{ createdAt: -1, _id: -1 }` with an opaque base64 cursor,
  matching the Phase 10 audit list so the frontend has one pagination shape. An unparseable
  cursor is a `400`. Offset paging is not offered.
- Filters on `GET /users`: `q` (prefix match on email or display name), `userStatus`, `roleId`,
  `cursor`, `limit`. Unknown query parameters are rejected by the schema.

### 4.4 Safety guards

These are the rules that make the API safe to hand to an administrator; each is a service-level
invariant with its own test, not a UI convention.

| Guard | Behaviour |
|---|---|
| Last administrator | A request that would leave the organization with zero active users holding `users.manage` fails with `409 LAST_ADMIN_REQUIRED` (applies to deactivate, remove, and role change) |
| Self-deactivation / self-removal | An actor may not deactivate or remove their own account: `409 CANNOT_MODIFY_SELF` |
| Built-in roles | `isBuiltIn` roles may have `description` changed; whether permissions may be edited follows the Phase 06 §12 decision, and is enforced here as `409 BUILT_IN_ROLE_IMMUTABLE` until that answer exists |
| Role in use | Soft-deleting a role referenced by an active membership fails with `409 ROLE_IN_USE`; no cascade |
| Unknown permission | A role carrying a permission absent from the Phase 09 catalog is rejected with `400 UNKNOWN_PERMISSION` — this is what keeps out-of-scope database-query permissions (README §5) unreachable |
| Email reuse | The partial unique index raises a driver duplicate-key error, converted to `409 IDENTITY_DUPLICATE_EMAIL`; never a read-then-write check |

### 4.5 Password handling

This phase never sets, hashes, compares, or returns a password. Two paths touch credentials:

- **User create** produces a user with `userStatus: 'invited'` and no `passwordHash`, then calls
  the Phase 08 service to issue a reset/activation token. The response reports only
  `passwordResetStatus` and `passwordResetRequestedAt` — never the token, never a link.
- **Admin reset trigger** (`POST /users/:userId/reset-password`) calls the same Phase 08 service
  and returns the same non-secret status.

Email delivery is out of scope for the whole plan (README §5, in-app notifications only), so how
the user actually receives the token is unresolved and blocks the honest wording of the Phase 15
dialog — see §12, question 2. The API must not claim an email was sent.

### 4.6 Audit

Every mutating route writes exactly one event through `recordAuditEvent` from the Phase 10
surface, inside the business transaction, using the catalog values Phase 10 already seeded:
`user.create`, `user.activate`, `user.deactivate`, `user.remove`,
`user.password_reset_requested`, `user.roles_changed`, `role.create`, `role.update`,
`membership.update`. Denied requests are recorded best-effort with `result: 'denied'` by the
Phase 09 guard, so a `403` here is not silent. Context carries ids, the previous and next
`userStatus`, and role-id arrays — never an email password, hash, or token.

## 5. Data model changes

**No new collection.** This phase uses `users`, `roles` and `memberships` from Phase 06, which
already carry `status: 'A' | 'D'`, UTC timestamps and tenant-scoped partial unique indexes.

Two additive changes:

| Collection | Change | Reason |
|---|---|---|
| `users` | Index `{ organizationId: 1, status: 1, createdAt: -1, _id: -1 }` | Keyset list path |
| `users` | Index `{ organizationId: 1, displayName: 1 }` | `q` prefix filter without a collection scan |
| `roles` | Index `{ organizationId: 1, status: 1, createdAt: -1, _id: -1 }` | Keyset list path |

Both ship as migrations under `backend/` per `.cursor/rules/data-model.mdc`. No field is added,
renamed or removed. `lastActivity` — which frontend §82 wants in the user table — does not exist
on the model; `lastLoginAt` does. See §12, question 4.

## 6. API contract — PROPOSED (needs approval before implementation)

All routes are under `/api/v1`, require a JWT, and return errors in the existing envelope
`{ error: { code, message, details? } }` with the `X-Correlation-Id` header from Phase 02.

### `POST /users` — `users.manage`

Request: `{ "email": "ada@acme.example", "displayName": "Ada Lovelace", "roleIds": ["<id>"] }`

Response `201`:

```json
{
  "id": "6712f0b1c9a41d2f8e4b3a04",
  "email": "ada@acme.example",
  "displayName": "Ada Lovelace",
  "userStatus": "invited",
  "roles": [{ "id": "6712f0b1c9a41d2f8e4b3a03", "name": "Member", "isBuiltIn": true }],
  "lastLoginAt": null,
  "passwordResetStatus": "pending",
  "createdAt": "2026-09-11T09:14:22.481Z"
}
```

Errors: `400 VALIDATION_ERROR`, `400 UNKNOWN_PERMISSION`, `403 FORBIDDEN`,
`409 IDENTITY_DUPLICATE_EMAIL`, `404 NOT_FOUND` (a `roleId` from another organization).

### `GET /users?q&userStatus&roleId&cursor&limit` — `users.manage`

Response `200`: `{ "items": [ <user as above> ], "pageInfo": { "nextCursor": "…", "hasMore": true } }`.
`status: 'D'` rows never appear. `disabled` users do appear.

### `GET /users/:userId` · `PATCH /users/:userId` — `users.manage`

`PATCH` accepts `displayName` and `roleIds`. Changing `email` is **proposed as not allowed**
(it is the sign-in identifier and an audit key) — confirm in §12, question 5. Response is the
same user object.

### `POST /users/:userId/activate` · `POST /users/:userId/deactivate` — `users.manage`

No body. Response `200` with the updated user (`userStatus` becomes `active` / `disabled`;
row `status` stays `'A'`). Errors: `409 LAST_ADMIN_REQUIRED`, `409 CANNOT_MODIFY_SELF`.

### `DELETE /users/:userId` — `users.manage`

Soft remove: `status: 'D'`, membership tombstoned, active sessions revoked through the Phase 07
refresh store. Response `204`. Errors as for deactivate.

### `POST /users/:userId/reset-password` — `users.manage`

No body. Response `200`:
`{ "userId": "…", "passwordResetStatus": "pending", "requestedAt": "2026-09-11T09:20:00.000Z" }`.
No token, no URL, no delivery claim.

### `GET /roles?cursor&limit` · `POST /roles` · `PATCH /roles/:roleId` — `roles.manage`

Role object: `{ id, name, description, permissions: string[], isBuiltIn, createdAt }`.
`permissions` are catalog identifiers; turning them into human-readable text is the frontend's
job (§85) and Phase 15 owns it. Errors: `409 IDENTITY_DUPLICATE_ROLE_NAME`,
`409 BUILT_IN_ROLE_IMMUTABLE`, `400 UNKNOWN_PERMISSION`.

### `PUT /users/:userId/roles` — `users.manage` + `roles.manage`

Request `{ "roleIds": ["<id>", "<id>"] }` replaces the membership's role set atomically.
Response `200` with the updated user. Errors: `409 LAST_ADMIN_REQUIRED`, `404 NOT_FOUND`.

**Not proposed here:** project access assignment (Phase 18) and organization create/update
(solution §8.4 lists them; no phase owns them — §12, question 6).

## 7. Configuration & environment variables

| Variable | Example | Required | Purpose |
|---|---|---|---|
| `IDENTITY_LIST_PAGE_SIZE_DEFAULT` | `25` | no (default `25`) | Default page size for user and role lists |
| `IDENTITY_LIST_PAGE_SIZE_MAX` | `100` | no (default `100`) | Hard cap on `limit`; larger values clamp |

Add both to `backend/.env.example` **and** mirror them into `backend/.env` in the same change
(`.cursor/rules/env-example-sync.mdc`). Never print `.env` contents. Both are read through the
Phase 01 config module; this module performs no `process.env` access.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/identity/identity.schemas.ts` | **New:** zod request/response schemas |
| `backend/src/modules/identity/identity.mappers.ts` | **New:** document → DTO, secret stripping |
| `backend/src/modules/identity/identity.mappers.test.ts` | **New:** no hash or token in any DTO |
| `backend/src/modules/identity/user.service.ts` | **New:** user lifecycle + guards |
| `backend/src/modules/identity/user.service.test.ts` | **New:** guard matrix, conflicts |
| `backend/src/modules/identity/role.service.ts` | **New:** role list/create/update |
| `backend/src/modules/identity/role.service.test.ts` | **New:** built-in and in-use rules |
| `backend/src/modules/identity/membership.service.ts` | **New:** role assignment |
| `backend/src/modules/identity/membership.service.test.ts` | **New:** atomic replace, last admin |
| `backend/src/modules/identity/identity.routes.ts` | **New:** all routes with permission guards |
| `backend/src/modules/identity/identity.routes.test.ts` | **New:** status codes, scoping, audit |
| `backend/src/modules/identity/index.ts` | **Change:** export the services and route plugin |
| `backend/src/shared/pagination/keysetCursor.ts` | **New or reuse:** shared cursor encode/decode |
| `backend/src/http/routes.ts` | **Change:** register `identityRoutes` |
| `backend/src/platform/config.ts` + `.test.ts` | **Change:** `identity` config group |
| `backend/src/migrations/<ts>-identity-list-indexes.ts` | **New:** the three indexes in §5 |
| `backend/.env.example` / `backend/.env` | Document and mirror the two variables |

## 9. Tests (≥ 80% line and branch)

### Unit (services, repositories mocked)

- `createUser` rejects a malformed email and a `roleIds` array that is empty.
- `createUser` maps a duplicate-key error to `IDENTITY_DUPLICATE_EMAIL`, not a driver error.
- `deactivateUser` throws `LAST_ADMIN_REQUIRED` when the target is the only active holder of
  `users.manage`, and succeeds when a second administrator exists.
- `deactivateUser` and `removeUser` throw `CANNOT_MODIFY_SELF` for the acting user.
- `removeUser` sets row `status: 'D'` and tombstones the membership; no hard delete is issued.
- `updateRole` rejects a permission string absent from the Phase 09 catalog.
- `updateRole` rejects a permission change on a built-in role while that decision is open.
- `softDeleteRole` throws `ROLE_IN_USE` when an active membership references it.
- `replaceUserRoles` writes one `user.roles_changed` audit event with previous and next ids.
- Cursor encode/decode round-trips; a tampered cursor raises `VALIDATION_ERROR`.
- Every mapper output is asserted to have no `passwordHash`, `password`, or token-shaped key.

### Integration (Fastify `app.inject`, Phase 03 Mongo harness)

- Each route returns `401` without a token and `403` without its permission.
- A `403` on an admin route produces one audit row with `result: 'denied'`.
- Organization A's administrator listing users never sees organization B's users, and fetching
  B's user by a valid id returns `404`, not `403`.
- Keyset pagination across three pages: no duplicates, no gaps, `hasMore` false on the last page.
- `limit` above `IDENTITY_LIST_PAGE_SIZE_MAX` clamps instead of erroring; `limit=0` is a `400`.
- `q`, `userStatus` and `roleId` each narrow the result set; unknown parameters are rejected.
- Create → list shows the user as `invited`; activate → list shows `active`; remove → the user
  disappears from the list but the audit rows remain.
- `POST /users/:id/reset-password` returns a status object and the response body contains no
  token; the same assertion runs over the emitted log lines.
- Creating a user with a `roleId` owned by another organization returns `404`.
- When the audit insert fails, the user create rolls back and no user row exists (Phase 10 §4.6).

### Unhappy paths that must be covered

- A removed user's refresh token no longer works (session revocation on soft remove).
- A concurrent double `POST /users` with the same email produces one user and one `409`.
- A serialization scan of every response body in this suite finds no hash, token, or credential.

## 10. Definition of Done

- [ ] Every route declares a permission from the Phase 09 catalog and is enforced by the guard.
- [ ] Every route resolves `organizationId` from the request context; no handler trusts a
      client-supplied scope.
- [ ] Cross-organization access returns `404`, proven by an integration test.
- [ ] Removal is a soft delete (`status: 'D'`); the codebase contains no hard delete of a user,
      role, or membership.
- [ ] Every mutating route writes exactly one audit event inside its transaction.
- [ ] No response, log line, or audit context contains a password hash, reset token, or any
      other secret.
- [ ] Both list endpoints use keyset pagination with a clamped `limit` and reject unknown query
      parameters.
- [ ] The last-administrator, self-modification, role-in-use and unknown-permission guards each
      have a named test.
- [ ] The two new variables are in `backend/.env.example` and mirrored into `backend/.env`.
- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass in `backend/`.
- [ ] Coverage for every file this phase touched is ≥ 80% line and ≥ 80% branch.

## 11. Documentation & ADR updates

- Update `docs/data-model.md` with the three new indexes in the same change as the migration.
- Add the identity routes to the API surface section of `docs/architecture.md` if one exists;
  otherwise confirm §10's audit row still matches what these routes write.
- No new ADR is expected — solution §8.4 already records the surface. If review changes the
  guard semantics in §4.4 (for example, allowing self-deactivation), record that as an ADR.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Project access at user-create time.** Frontend §83 asks the administrator to assign project
   access while creating a user, but `ProjectMember` is Phase 18. Should `POST /users` accept a
   project-access array once Phase 18 lands, or does Phase 15 send a second request? Nothing is
   invented here until this is answered.
2. **Reset-token delivery (blocking for Phase 15 copy).** Email is out of scope for the plan.
   How does the user receive the token — an operator copies it, an in-app notification, or
   something else? `POST /users/:id/reset-password` must not imply an email was sent.
3. **Who may read the user list?** Proposed as `users.manage`. Should a non-administrator with
   `org.view` be able to see colleagues (for project-member pickers in Phase 19)?
4. **`lastActivity` for the admin table.** Frontend §82 shows "Last activity". The model has
   `lastLoginAt` only. Is last sign-in an acceptable definition, or does a real activity
   timestamp need a new field and a write path?
5. **Is email mutable?** Proposed as immutable after create. If administrators must be able to
   correct a typo, the endpoint needs re-verification and audit rules for identifier changes.
6. **Organization create/update endpoints.** Solution §8.4 lists them, but no phase owns them
   and decision D6 makes organization creation an operator action (Phase 06 seed). Confirm they
   stay out of the plan, or assign them a phase.
