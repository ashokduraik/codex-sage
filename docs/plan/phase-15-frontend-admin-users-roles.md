# Phase 15 — Frontend admin users & roles slice

- **Layer:** FE
- **Depends on:** Phase 11 (admin identity APIs), Phase 14 (real session and caller permissions)
- **Unblocks:** Phase 16 (shares the admin list/filter patterns), Phase 19 (project access
  reuses the membership controls)
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §82 (user management), §83 (admin user
  creation), §84 (password reset), §85 (role and permission UX), §88 (empty states),
  §90 (error states), §105.35 (no secrets redisplayed);
  `backend/requirments.md` §5, §6, §135, §136; `backend/solution.md` §8.2, §8.4

## 1. Goal

After this phase the two admin identity screens run on the real backend. `AdminUsers.jsx` lists
users from the API with pagination and filters, showing user, role, status and last sign-in;
an administrator can create a user with a role, activate, deactivate, soft-remove after a
consequence confirmation, and set a new password for another user (the secret is never shown
again). `AdminRoles.jsx` renders roles and permissions in human-readable, logically grouped
language with no internal permission identifier on screen.

Project access columns and assignment at user-create time belong to **Phases 18 / 19**, not
here. You can see it working by signing in as an organization administrator, creating a user,
seeing it appear in the list without a page reload, setting a password that is never echoed,
and — signed in as a non-administrator — watching an attempted action return a readable
authorization message instead of a silent failure.

## 2. Why this phase is here

It is the first slice that consumes Phase 11's admin APIs, so it validates the identity
contract end to end before projects, sources and chat are built on top of the same RBAC. It
must follow Phase 14 because every control on these screens depends on the caller's real
permissions, and because `403` handling is only meaningful once `401` has a defined meaning.

It comes before the project slices so identity admin is proven end to end. Project access is
**not** assigned here; Phase 18 owns membership and Phase 19 owns the project-side UI.

## 3. Scope

### In scope

- React Query hooks for the admin identity endpoints under `features/admin/api/`.
- User list: server-driven pagination, a text filter, and role/status filters; columns for
  user, role, status and last sign-in (`lastLoginAt`). Project-access column is **not** in
  this slice (Phase 19).
- Create-user flow: user information, role, submit. No project-access picker (§83 deferred
  to Phase 19).
- Role change, activate, deactivate as mutations with per-row in-flight state.
- Soft-remove with a consequence confirmation dialog that explains what access is lost before
  proceeding (§82).
- Administrator-set password: names the affected user, a `newPassword` field (typed, never
  echoed back, never cached), and a completed status from the API (**D15**). Copy states
  that the administrator must communicate the password out of band; it never claims an email
  was sent.
- `AdminRoles`: real roles and their permissions rendered as grouped, human-readable statements
  with no internal identifiers (§85).
- `403` handling: an understandable authorization message, no sign-out, no silent no-op (§85).
- Empty, loading and error states for both screens (§88, §90).
- Remove this feature's mock-data usage.

### Out of scope (owner phase)

- Audit screen — **Phase 16**.
- Usage and retention screens (`AdminUsage.jsx`, `AdminRetention.jsx`) — **Phases 59, 60**.
- `AdminProjects.jsx` and project membership management from the project side — **Phase 19**.
- Assigning project access at user create — **Phase 18 / 19**. Do not invent a membership
  request here.
- Role creation and permission editing, unless Phase 11 exposes write endpoints for roles; the
  default here is a read-only roles view matching today's UI.
- Deleting `shared/mock-data/` — D7: it goes when nothing imports it.
- Self-service password change — **Phase 14**.

## 4. Design

### 4.1 Hooks and components

`AdminUsers.jsx` is 330 lines today with all state inline. Split it so the component stays
presentational (`web-frontend.mdc`: thin components, logic in hooks):

```text
features/admin/
├── api/adminIdentityApi.ts     typed calls over shared/api
├── api/useUsers.ts             list query (filters + page in the query key)
├── api/useCreateUser.ts        create mutation
├── api/useUpdateUserRole.ts    role change mutation
├── api/useSetUserStatus.ts     activate / deactivate mutation
├── api/useRemoveUser.ts        soft-remove mutation
├── api/useResetUserPassword.ts admin-initiated reset mutation
├── api/useRoles.ts             roles query
├── permissionCatalog.ts        permission id → i18n key + group (shared by both screens)
├── AdminUsers.jsx              list + dialogs
└── AdminRoles.jsx              grouped permission matrix
```

Filters and the page cursor live in the URL query string so a filtered list is shareable and
survives a reload, and they are part of the React Query key so each combination caches
independently.

### 4.2 List, pagination and filters

The list query key is `['admin', 'users', { q, userStatus, roleId, cursor }]`. Pagination is
keyset (`cursor` + `nextCursor`) matching Phase 11. Filter names **must** match Phase 11:
`q`, `userStatus`, `roleId` — not `search` / `role` / `status`.

Text search is debounced before it reaches the query key so typing does not issue a request per
keystroke. `placeholderData` keeps the previous page visible while the next one loads, which
avoids the layout jump frontend §89 warns about.

The row columns for this slice: user (name + email), role, status, last sign-in. `lastLoginAt`
is rendered as last activity through the existing `shared/lib/format.js` helpers and is stored
and compared in UTC. Project access is omitted until Phase 19.

### 4.3 Mutations and per-row feedback

Every mutation follows `.cursor/rules/ui-action-feedback.mdc`: inline loader, disabled control
(and its sibling controls in the same row or dialog), `aria-busy`, and an inline `role="alert"`
error sourced from `ApiError.message` with `t('errors.unexpected')` as the fallback. Because
several rows can be in flight at once, in-flight state is tracked per row via the mutation's
`variables`, not by a single boolean for the whole table.

On success each mutation invalidates the users list. Optimistic updates are used only for the
role select and the activate/deactivate toggle, where the previous value is known and can be
rolled back on failure; create and remove wait for the server.

The current code calls `toast.success()` immediately after a mock call, which would assert
success the backend never confirmed (§98). Toasts stay only as a secondary signal fired from
`onSuccess`, and are never the only feedback path.

### 4.4 Remove with consequences

§82 requires confirming access consequences before removing a user. The dialog names the user,
states plainly what removal means (loses access to the organization and all its projects;
existing audit history is retained), and distinguishes removal from deactivation. The confirm
button carries the destructive styling and is the only control that proceeds. Removal is a soft
delete on the backend (`.cursor/rules/soft-delete.mdc`), so the copy must not promise erasure.

The current implementation calls `removeUser(user.id)` straight from a dropdown item with no
confirmation at all and logs it as "Deactivated user" — both are corrected here.

### 4.5 Administrator-set password (**D15**)

The dialog names the affected user, explains that the administrator is setting a new password
which they must communicate out of band, and requires typing `newPassword` (plus a local
confirm field that is never sent twice). On success it shows `passwordResetStatus: completed`
from the API. The secret is never written to the query cache, never logged, never toasted,
and never shown again on reload (frontend §107, §105.35). The dialog must not claim an email
was sent.

### 4.6 Roles and permissions in human language

Phase 11 returns permission identifiers from the catalog in `solution.md` §8.2
(`users.manage`, `projects.create`, `chat.ask`, …). §85 forbids showing those. `permissionCatalog.ts`
maps each known identifier to an i18n key phrased as the requirement's examples ("Can manage
users and roles") and to a display group (organization, projects, sources and knowledge,
conversations and search, administration). An identifier the frontend does not know is shown
under an "other permissions" group with a generic localized label and never with its raw id —
it is not hidden, because hiding it would misrepresent the role, and it is not invented, because
no wording is fabricated for it.

`AdminRoles` today hardcodes `ROLES = ['Admin', 'Editor', 'Viewer']` and reads
`PERMISSION_LABELS` / `ROLE_PERMISSIONS` from the mock module; both go away. Role columns come
from the roles endpoint, so built-in and custom roles render the same way.

### 4.7 Authorization failures

A `403` from any action on these screens renders an understandable authorization message next to
the control that caused it, keeps the user signed in, and leaves the list untouched. Controls
the caller's permissions do not allow are not rendered — but that is UX, not security: the
backend enforces independently, and the `403` path is still implemented and tested, because
frontend §85 and `AGENTS.md` both say hiding a control is not a control.

### 4.8 Mock exports that stop being used

After this phase, `features/admin/AdminUsers.jsx` and `AdminRoles.jsx` no longer import from
`@/shared/mock-data`. Specifically these stop being used **by this feature**:

- `useAppData()` fields `users`, `createUser`, `updateUser`, `removeUser`, `logAudit`
- `CreateUserInput` type
- `PERMISSION_LABELS` and `ROLE_PERMISSIONS`
- `AppUser` / `User` from `shared/mock-data domain shapes`, replaced by the API response type

`useAppData` and `logAudit` remain in the codebase for the features not yet rewired (projects,
chat, processing, usage, retention, audit until Phase 16). The mock module is deleted in a later
phase once nothing imports it (D7).

## 5. Data model changes

**None.** Frontend-only phase; no collection, field or index changes.

## 6. API contract — PROPOSED (needs approval before implementation)

Endpoints **consumed**, defined by Phase 11 (`solution.md` §8.4). This table records what this
slice needs from them; it does not define new endpoints.

| Method & path | Permission | Needs from the response |
|---|---|---|
| `GET /api/v1/users` | `users.manage` | page of users + `nextCursor`; per user: id, display name, email, role(s), `userStatus`, `lastLoginAt` |
| `POST /api/v1/users` | `users.manage` | the created user, so the list can be updated |
| `PATCH /api/v1/users/:id` | `users.manage` | the updated user (used for role change) |
| `POST /api/v1/users/:id/activate` | `users.manage` | updated `userStatus` |
| `POST /api/v1/users/:id/deactivate` | `users.manage` | updated `userStatus` |
| `DELETE /api/v1/users/:id` | `users.manage` | soft-remove confirmation (`status: 'D'` server-side) |
| `POST /api/v1/users/:id/reset-password` | `users.manage` | `{ newPassword }` in; `{ passwordResetStatus: 'completed' }` out; secret never returned |
| `GET /api/v1/roles` | `roles.manage` or `org.view` | roles with their permission identifiers |

Frontend-visible contract details:

- Query parameters this slice sends on the user list: `q`, `userStatus`, `roleId`, `cursor`,
  `limit` — matching Phase 11 exactly.
- `Idempotency-Key` is sent on create and on admin password set (`solution.md` §13), generated
  per submission so a retried click cannot create two users.
- Errors use `{ error: { code, message, details? } }`. Codes this slice distinguishes by code:
  duplicate email (`409`), validation failure (`400`/`422`), insufficient permission (`403`),
  user not found (`404`), rate limited (`429`).
- The correlation ID from Phase 13 is displayed on failures (frontend §90, §105.38).
- **Never** returned or rendered: password hashes, the typed `newPassword` after submit,
  session material of any kind (frontend §107, §105.35).

## 7. Configuration & environment variables

**None.** This slice adds no variable; it calls the backend through `shared/api` using
`VITE_API_BASE_URL` from Phase 13. Do not add tunables as env vars
(`.cursor/rules/env-config.mdc`). Any future `.env.example` change must still be mirrored into
`.env` in the same change.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/admin/api/adminIdentityApi.js` | **New:** typed calls over `shared/api` |
| `frontend/src/features/admin/api/adminIdentityApi.test.js` | **New:** request shapes, error mapping |
| `frontend/src/features/admin/api/useUsers.js` | **New:** list query with filters and cursor |
| `frontend/src/features/admin/api/useUsers.test.js` | **New:** key changes, pagination, debounce |
| `frontend/src/features/admin/api/useUserMutations.js` | **New:** create, role change, activate, deactivate, remove, reset |
| `frontend/src/features/admin/api/useUserMutations.test.js` | **New:** success, rollback, `403`, `409` |
| `frontend/src/features/admin/api/useRoles.js` | **New:** roles query |
| `frontend/src/features/admin/permissionCatalog.js` | **New:** permission id → i18n key + group |
| `frontend/src/features/admin/permissionCatalog.test.js` | **New:** known ids, unknown id fallback |
| `frontend/src/features/admin/AdminUsers.jsx` | **Rewrite:** real API, pagination, filters, dialogs |
| `frontend/src/features/admin/AdminUsers.test.jsx` | **Rewrite:** list, create, remove, reset, `403`, empty, loading, error |
| `frontend/src/features/admin/AdminRoles.jsx` | **Rewrite:** real roles, grouped human-readable permissions |
| `frontend/src/features/admin/AdminRoles.test.jsx` | **Rewrite:** grouping, no raw identifiers, empty/loading/error |
| `frontend/src/shared/i18n/locales/en.json` | **Change:** permission statements, groups, consequence copy, reset-status copy, pagination and filter labels |
| `frontend/src/shared/mock-data domain shapes` | **Change:** `AppUser` / `User` no longer describe the admin list once the API type lands |

## 9. Tests (≥ 80% line and branch)

`fetch` is mocked; component tests use `renderWithProviders`.

### AdminUsers

- Renders user, role, status and last sign-in for each returned user. Project access is not
  rendered in this slice.
- Shows the loading state, then the list; shows the empty state when the page has no users.
- A list failure renders `role="alert"` with the backend message and a retry action.
- Changing a filter issues a new request and resets the cursor; the URL reflects the filters.
- Advancing a page requests the next cursor and keeps the previous page visible while loading.
- Create: submit disables the dialog controls, shows the loader, sets `aria-busy`; on success
  the dialog closes and the list refetches.
- Create with a duplicate email (`409`) renders the backend message inline and leaves the dialog
  open with the entered values.
- Role change is optimistic and rolls back to the previous role when the request fails.
- Deactivate then activate: the row status reflects each result and only that row shows a loader.
- Remove opens the consequence dialog; cancelling issues no request; confirming calls the API.
- Admin password set names the affected user, accepts `newPassword` without echoing it, and
  renders `completed` from the API. Copy does not claim an email was sent.
- A `403` on any action renders the authorization message and the user stays signed in.
- No horizontal scroll at 375 px, 768 px and 1280 px; the table reflows to a stacked layout on
  mobile.

### AdminRoles

- Renders one column per role returned by the API, including a custom role.
- Every permission is rendered as a human-readable statement in its group.
- No raw permission identifier appears anywhere in the rendered output (asserted directly).
- An unknown permission identifier appears under the other-permissions group with the generic
  label, not with its id.
- Loading, empty and error states render.

## 10. Definition of Done

- [ ] `AdminUsers.jsx` and `AdminRoles.jsx` contain no import from `@/shared/mock-data`.
- [ ] No `fetch` call sits in a component or an effect; all server state is React Query.
- [ ] Every action button has a loader, `disabled`, `aria-busy`, and an inline `role="alert"`
      error from `error.message` with a localized fallback.
- [ ] Removing a user requires the consequence confirmation before any request is sent.
- [ ] The admin set-password dialog names the user, never echoes `newPassword`, shows
      `completed` from the API, and claims no email delivery.
- [ ] No internal permission identifier is rendered anywhere (asserted in a test).
- [ ] A `403` renders an understandable authorization message and does not sign the user out.
- [ ] No user-facing string is hardcoded; all copy comes from `en.json`.
- [ ] Both screens render without horizontal scroll at 375 px, 768 px and 1280 px.
- [ ] `npm run lint` and `npm test` pass in `frontend/`.
- [ ] Coverage for every file this phase touched is ≥ 80% line and ≥ 80% branch.

## 11. Documentation & ADR updates

- No ADR is expected: this slice makes no new architectural decision, it consumes Phase 11's.
  If the permission-label ownership question in section 12 is resolved in favour of the backend
  supplying labels, that **is** an ADR and must be written.
- `docs/architecture.md` needs no change; the admin surface is already covered by §9.
- Do not edit `docs/plan/README.md` or another phase document from this phase.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Pagination style and parameter names.** **Decided (Phase 11).** Keyset; filters are `q`,
   `userStatus`, `roleId`.
2. **Admin reset response.** **Decided (D15).** Body `{ newPassword }`; response
   `{ passwordResetStatus: 'completed' }`; secret never returned; out-of-band delivery.
3. **Permission labels: whose job?** Should the backend return human-readable labels and groups
   with each permission, or does the frontend own the catalog (as proposed)? A frontend-owned
   catalog drifts whenever the backend adds a permission.
4. **Roles: read-only or editable?** Today's screen is a read-only matrix. `solution.md` §8.4
   lists `GET/POST /roles` and `PATCH /roles/:id`, which implies role editing. If editing is in
   this phase, the phase is oversized and role editing should be split into its own change.
5. **Multiple roles per user.** `Membership` carries `roleIds[]` (plural) but the UI has a
   single role select per row. Is one role per user guaranteed in this slice?
6. **Project access assignment.** **Deferred to Phase 18 / 19.** This slice does not send
   membership requests and does not render a project-access column.
7. **Requirement reference mismatch.** The 403-handling requirement is frontend §85 and §90;
   §105.29 is "the UI must minimize unnecessary clicks" and does not cover authorization. This
   document cites §85 and §90 deliberately.
