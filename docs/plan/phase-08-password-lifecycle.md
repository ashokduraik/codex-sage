# Phase 08 — Password lifecycle: signed-in change and admin-set password

- **Layer:** BE
- **Depends on:** Phase 07 (hashing, sessions, principal resolution)
- **Unblocks:** Phase 11 (admin user surface), Phase 14 (frontend auth slice)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §5 (password management, password reset,
  administrators reset passwords for permitted users), §88 (security), §147 (data privacy),
  §148 (secret protection), §149 (logging); `frontend/requirments.md` §7A (password change and
  reset initiation for the signed-in user), §84 (administrator-initiated reset and its status);
  `backend/solution.md` §8.3 (password reset), §8.4 (`POST /users/:id/reset-password`), §14
  (no email or SMS channel in this slice)

## 1. Goal

After this phase a password can be changed or reset without a developer touching the database.
A signed-in user can change their own password. A user who has forgotten it contacts an
administrator; the administrator sets a new password (**D15** — no public forgot/reset-token
flow, no email). Every path invalidates the affected user's existing sessions. An
administrator-set password sets `mustChangePassword` so the user must change it before using
other authenticated APIs.

You can see it working by changing your password through the API and watching the previously
issued access token stop being accepted on the next request, and by an administrator setting a
new password for another user in the same organization (the new secret never appears in the
response).

## 2. Why this phase is here

It sits directly on Phase 07: hashing, the `loginsessions` collection and the
`passwordUpdatedAt`-versus-token-`iat` check all come from there, and this phase is the first
consumer of all three. It comes before Phase 11 so that the admin user API has a reset
operation to expose rather than being retrofitted, and before Phase 14 so the frontend auth
slice can build against a settled contract.

It cannot come earlier: without sessions there is nothing to invalidate, which is the part of
a password reset that actually protects the account.

## 3. Scope

### In scope

- Authenticated self-service password change.
- Administrator-set password for a user in the administrator's organization (**D15**). The
  administrator supplies `newPassword` in the request; the value is never returned.
- Revocation of every session for a user whenever their password changes, by any path.
- A password policy module: minimum length 6; rejection of the current password; history
  check disabled (`PASSWORD_HISTORY_LENGTH = 0`).
- `mustChangePassword` set on admin set, cleared on self-service change; authenticate rejects
  non-allowlisted routes while the flag is true.
- A read model (`passwordResetStatus`) that Phase 11 surfaces on the admin user detail
  (`state: 'none' | 'completed'` from `passwordUpdatedAt`).

### Out of scope (owner phase)

- **Public forgot / email delivery.** **Decided (D15):** there is no public forgot endpoint and
  no email/SMS channel. The administrator communicates the new password out of band.
- In-app rate limiting — **out of scope** (Phase 12 / solution §13.1). Do not declare
  `rateLimitClass` on password routes.
- Audit events for password change, admin-initiated reset and reset redemption — **Phase 10**.
  Leave the hook: the password service returns typed outcomes at a single call site, as Phase
  07 does for login.
- Permission enforcement of `users.manage` on the admin route — **Phase 09** provides
  `requirePermissions`. Until it lands, the admin route is registered with its permission
  declared in `config.requiredPermissions` and guarded by an explicit inline check that Phase
  09 replaces with the shared factory.
- The admin users list and detail endpoints — **Phase 11**.
- Every UI screen — **Phase 14** (self-service) and **Phase 15** (admin).
- Notifying a user in-app that their password was reset — **Phase 58**.

## 4. Design

### 4.1 Two entry points, one write path

Both flows converge on a single internal function that (1) validates the new password
against the policy, (2) hashes it with the Phase 07 hasher, (3) writes `passwordHash`,
`passwordUpdatedAt`, and `mustChangePassword`, (4) sets `userStatus` to `active` if the user
was `invited`, and (5) revokes every session for that user. Steps 3–5 run inside one
transaction (decision D5).

```text
self change   → verify current password  ─┐
admin set     → users.manage + org scope ─┴→ applyNewPassword(userId, newPassword, reason)
```

**D15:** the administrator *does* set a password value. The user cannot complete a reset
themselves (no email, no public token). The secret originates from the administrator and is
never echoed in a response (backend §148). The administrator communicates it out of band.

### 4.2 No reset-token collection

There is no `passwordResetTokens` collection and no public forgot/reset routes.

### 4.3 Admin-set password

`POST /users/:userId/reset-password` accepts `newPassword`, runs `applyNewPassword` with
reason `admin_set`, and returns status only. Cross-tenant targets are `404`. The caller
cannot target themselves (`409 CANNOT_MODIFY_SELF` — they use `/auth/password/change`).

### 4.4 Admin-initiated reset status

`POST /api/v1/users/:userId/reset-password` requires `users.manage`, resolves the target user
strictly inside `principal.orgId`, and returns a status object with
`deliveryChannel: 'administrator'` so the UI does not imply email was sent.

| `state` / `passwordResetStatus` | Meaning |
|---|---|
| `none` | No password write has been recorded (`passwordUpdatedAt` unset) |
| `completed` | A password has been set (self or admin); `completedAt` is `passwordUpdatedAt` |

### 4.5 Session invalidation

- **Refresh tokens:** every open `loginsessions` document for that user is revoked with
  `revokedReason: 'password_changed'` (`revokeAllLoginSessionsForUser`).
- **Access tokens:** Phase 07 `authenticate` rejects a token whose `iat` predates
  `user.passwordUpdatedAt`.

A self-service password change also revokes the caller's own session. The response tells the
client it must sign in again (`reauthenticationRequired: true`).

### 4.6 Policy (locked)

`src/modules/auth/passwordPolicy.js` validates a candidate and returns violation codes.

- `PASSWORD_MIN_LENGTH = 6`
- `PASSWORD_HISTORY_LENGTH = 0` (reuse history disabled; no `passwordHistory` field)
- Rejected if it equals the user's current password (`SAME_AS_CURRENT`)
- No composition rules (mandatory symbol classes)

### 4.7 Must-change-on-next-login (locked)

Admin set sets `mustChangePassword: true`. Self-service change clears it. Login / refresh /
`GET /auth/me` expose the flag. `authenticate` rejects other routes with
`403 PASSWORD_CHANGE_REQUIRED` unless `config.allowWhenMustChangePassword: true`
(password change and `/auth/me`).

## 5. Data model changes

**No `passwordResetTokens` collection (D15).** **No `passwordHistory` (history length 0).**

### Changed collection: `users`

| Field | Type | Notes |
|---|---|---|
| `mustChangePassword` | Boolean, default `false` | Set on admin set; cleared on self change |

`passwordUpdatedAt` already exists from Phase 06/07 and is written here on every change.

## 6. API contract (locked)

### `POST /api/v1/auth/password/change`

- **Auth:** access token. **Permission:** none beyond authentication.
- `config: { routeAccess: 'authenticated', allowWhenMustChangePassword: true }`

```json
{ "currentPassword": "<user supplied>", "newPassword": "<user supplied>" }
```

Response `200`:

```json
{ "passwordChanged": true, "sessionsRevoked": true, "reauthenticationRequired": true }
```

Errors: `400 VALIDATION_ERROR`; `401 UNAUTHENTICATED`; `403 INVALID_CURRENT_PASSWORD`;
`422 PASSWORD_POLICY_VIOLATION` with
`details: { violations: ['TOO_SHORT' | 'SAME_AS_CURRENT'] }`;
(Phase 12 idempotency is separate; in-app rate limiting is out of scope).

### `POST /api/v1/auth/password/forgot` and `POST /api/v1/auth/password/reset`

**Not shipped.** Decision D15. Phase 09's public allowlist must not include these paths.

### `POST /api/v1/users/:userId/reset-password`

- **Auth:** access token. **Permission:** `users.manage` (interim: org_admin or role with
  `users.manage`; Phase 09 replaces with `requirePermissions`).

```json
{ "newPassword": "<admin supplied>" }
```

Response `200`:

```json
{
  "userId": "6712f0b1c9a41d2f8e4b3a02",
  "passwordResetStatus": "completed",
  "completedAt": "2026-05-04T09:12:00.000Z",
  "sessionsRevoked": true,
  "deliveryChannel": "administrator"
}
```

Errors: `401 UNAUTHENTICATED`; `403 FORBIDDEN`; `404 NOT_FOUND`;
`409 CANNOT_MODIFY_SELF`; `422 PASSWORD_POLICY_VIOLATION`.

## 7. Configuration & environment variables

**None.** No new `.env` keys.

| Constant | Value | Where |
|---|---|---|
| `PASSWORD_MIN_LENGTH` | `6` | `modules/auth/passwordPolicy.js` |
| `PASSWORD_HISTORY_LENGTH` | `0` | `modules/auth/passwordPolicy.js` |

## 8. Files to create or change

See implementation plan / ADR 0013. Route modules: `password.routes.js`,
`adminPasswordReset.routes.js`; service: `password.service.js`; policy: `passwordPolicy.js`.

## 9. Tests (≥ 80% line and branch)

See Definition of Done and the implementation plan test list.

## 10. Definition of Done

- [x] Both write paths go through one transactional `applyNewPassword`.
- [x] There is no public forgot/reset-token route and no `passwordResetTokens` collection (D15).
- [x] Every password change revokes all of that user's sessions and writes `passwordUpdatedAt`.
- [x] Admin set sets `mustChangePassword`; self change clears it; non-allowlisted routes fail
      with `PASSWORD_CHANGE_REQUIRED` while set.
- [x] The admin reset route resolves the target inside the caller's organization only and
      returns `404` for anyone outside it.
- [x] The administrator response never echoes `newPassword` and never implies an email was sent.
- [x] Rate-limit class and audit hook points are declared for Phases 12 and 10.
- [x] No new `.env` keys. Password policy numbers are constants.
- [x] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/data-model.md`: `users.mustChangePassword`.
- `docs/adr/0013-admin-mediated-password-reset.md`: D15.
- `backend/solution.md` §8.3: administrator sets `newPassword`; secret never returned.

## 12. Risks & open questions — resolved

1. **How does a user receive a new password?** D15 — admin sets; out of band.
2. **Password minimum length.** Locked: `6`. No org override in this phase.
3. **Password history.** Locked: disabled (`0`); no `passwordHistory` field.
4. **Must-change-on-next-login after admin set.** Locked: yes (`mustChangePassword`).
5. **Disable account until reset?** Locked: no — apply password + revoke sessions immediately;
   do not force `invited`/`disabled`.
6. **Session revocation timing.** Locked: immediate on apply (same transaction).
7. **Who may reset whose password?** Locked: any caller with `users.manage` in the same org
   (including other org admins); self via admin route → `409 CANNOT_MODIFY_SELF`.
8. **Email channel.** D15 — out of scope.
