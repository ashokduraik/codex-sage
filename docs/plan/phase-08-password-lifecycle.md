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
flow, no email). Every path invalidates the affected user's existing sessions.

You can see it working by changing your password through the API and watching the previously
issued access token stop being accepted on the next request, and by an administrator setting a
new password for another user in the same organization (the new secret never appears in the
response).

## 2. Why this phase is here

It sits directly on Phase 07: hashing, the `sessions` collection and the
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
- A password policy module: minimum length, a rejection of the current password, and the
  proposed history check.
- A read model (`passwordResetStatus`) that Phase 11 surfaces on the admin user detail
  (`state: 'none' | 'completed'` from `passwordUpdatedAt` / last admin-set timestamp).

### Out of scope (owner phase)

- **Public forgot / email delivery.** **Decided (D15):** there is no public forgot endpoint and
  no email/SMS channel. The administrator communicates the new password out of band.
- Rate limiting on the reset routes (solution §13.1 puts login and password change in one class at
  10/min) — **Phase 12**. Leave the hook: every route here declares
  `config: { rateLimitClass: 'auth' }`.
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
against the policy, (2) hashes it with the Phase 07 hasher, (3) writes `passwordHash` and
`passwordUpdatedAt`, (4) sets `userStatus` to `active` if the user was `invited`, and (5)
revokes every session for that user. Steps 3–5 run inside one transaction (decision D5).

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
cannot target themselves (`409` — they use `/auth/password/change`).

Creating a second token for a user invalidates their outstanding ones, so a user who clicks
twice does not end up with two live tokens.

### 4.4 Admin-initiated reset and what the administrator is told

`POST /api/v1/users/:userId/reset-password` (solution §8.4) requires `users.manage`, resolves
the target user strictly inside `principal.organizationId`, and returns a reset status object.
A target in another organization returns `404`, never `403` — see Phase 09 §4.5.

Frontend §84 requires the UI to communicate which user is affected, what will happen, whether
the user will receive instructions, and the current reset status. The API therefore returns a
`deliveryChannel` field so the UI can state the truth instead of implying an email was sent.
Its value depends entirely on the answer to section 12 question 1, and it is the field that
makes the "no email channel" constraint visible instead of hidden.

The status read model, computed from the newest token for that user:

| `state` | Meaning |
|---|---|
| `none` | No reset has ever been started |
| `pending` | A token exists, unused, not yet expired |
| `completed` | The most recent token was redeemed |
| `expired` | The most recent token passed `expiresAt` unused |

An administrator sees the state, `requestedAt`, `expiresAt` and `completedAt`. They never see
the token value or its hash, and the endpoint that lists users must not include either.

### 4.5 Session invalidation

Two mechanisms, both needed:

- **Refresh tokens:** every `sessions` row for that user is revoked with
  `revokedReason: 'password_changed'`. Immediate and complete.
- **Access tokens:** already-issued JWTs cannot be recalled. The Phase 07 `authenticate`
  preHandler already rejects a token whose `iat` predates `user.passwordUpdatedAt` (Phase 07
  §4.4 step 4), so writing `passwordUpdatedAt` in the same transaction invalidates them on the
  next request without any extra lookup.

A self-service password change also revokes the caller's own session. The response therefore
tells the client it must sign in again rather than leaving it to discover this on its next
request (frontend §7A).

### 4.6 Policy

`src/modules/auth/passwordPolicy.js` validates a candidate password and returns a list of
violation codes rather than a sentence, so the UI can localise them (README §4, frontend i18n).

Proposed rules, all **PROPOSED** and all listed in section 12:

- Minimum length from a named constant; no maximum below what argon2 accepts.
- Rejected if it equals the user's current password.
- Rejected if it matches one of the last *N* hashes in `passwordHistory`, with *N* a named
  constant and `0` disabling the check.
- No composition rules (mandatory symbol classes), because they push users toward predictable
  substitutions; length is the control that matters.

`passwordHistory` stores only argon2 hashes, is capped at *N* entries, and is `select: false`
like `passwordHash`. Comparing a candidate against *N* stored hashes costs *N* argon2
verifications, so *N* must stay small — this is a real cost, not a free check.

## 5. Data model changes

**No `passwordResetTokens` collection (D15).**

### Changed collection: `users`

| Field | Type | Notes |
|---|---|---|
| `passwordHistory` | `[{ hash: string, changedAt: Date }]`, `select: false`, default `[]` | Capped at `PASSWORD_HISTORY_LENGTH`; only if the reuse check is confirmed (section 12) |

`passwordUpdatedAt` already exists from Phase 06 and is written here on every change.

## 6. API contract — PROPOSED (needs approval before implementation)

### `POST /api/v1/auth/password/change`

- **Auth:** access token. **Permission:** none beyond authentication.

```json
{ "currentPassword": "<user supplied>", "newPassword": "<user supplied>" }
```

Response `200`:

```json
{ "passwordChanged": true, "sessionsRevoked": true, "reauthenticationRequired": true }
```

Errors: `400 VALIDATION_ERROR`; `401 UNAUTHENTICATED`; `403 INVALID_CURRENT_PASSWORD`;
`422 PASSWORD_POLICY_VIOLATION` with
`details: { violations: ['TOO_SHORT' | 'SAME_AS_CURRENT' | 'RECENTLY_USED'] }`;
`429 RATE_LIMITED` (Phase 12).

### `POST /api/v1/auth/password/forgot` and `POST /api/v1/auth/password/reset`

**Not shipped.** Decision D15 removes the public forgot/reset-token flow. Phase 09's public
allowlist must not include these paths.

### `POST /api/v1/users/:userId/reset-password`

- **Auth:** access token. **Permission:** `users.manage` (enforced by Phase 09).

```json
{ "newPassword": "<admin supplied>" }
```

Response `200`:

```json
{
  "userId": "6712f0b1c9a41d2f8e4b3a02",
  "resetStatus": {
    "state": "completed",
    "completedAt": "2026-05-04T09:12:00.000Z"
  },
  "sessionsRevoked": true,
  "deliveryChannel": "administrator"
}
```

The new password **must not** appear in this body, in logs, or in audit context (backend §148,
frontend §105.35). Errors: `401 UNAUTHENTICATED`; `403 FORBIDDEN`; `404 NOT_FOUND` (no such
user in the caller's organization, or the user is soft-deleted); `409 CONFLICT` (target is the
caller — self-service `POST /auth/password/change` is the correct route);
`422 PASSWORD_POLICY_VIOLATION`; `429 RATE_LIMITED`.

Whether this response also carries the token value is the open question in section 12. It is
deliberately absent from the proposal above: returning a credential for another account in an
API response is exactly what backend §148 forbids, and it must be an explicit, recorded
decision if it happens at all.

## 7. Configuration & environment variables

**None.** No new `.env` keys. Password policy numbers are named constants
(`.cursor/rules/env-config.mdc`). Concrete min-length and history values are chosen in
section 12.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `PASSWORD_MIN_LENGTH` | see section 12 | `modules/auth/passwordPolicy.js` | Minimum accepted password length |
| `PASSWORD_HISTORY_LENGTH` | see section 12 | `modules/auth/passwordPolicy.js` | Previous hashes checked; `0` disables |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/platform/logger.js` | **Extend:** redact `currentPassword`, `newPassword`, `token` |
| `backend/src/modules/auth/passwordPolicy.js` | **New:** validation returning violation codes |
| `backend/src/modules/auth/passwordPolicy.test.js` | **New** |
| `backend/src/modules/auth/password.service.js` | **New:** change, admin set, `applyNewPassword` |
| `backend/src/modules/auth/password.service.test.js` | **New** |
| `backend/src/modules/auth/password.routes.js` | **New:** `POST /auth/password/change` only |
| `backend/src/modules/auth/password.routes.test.js` | **New** |
| `backend/src/modules/identity/user.model.js` | **Extend:** `passwordHistory` |
| `backend/src/modules/identity/user.repository.js` | **Extend:** write hash + history + `passwordUpdatedAt` in one update |
| `backend/src/modules/identity/user.repository.test.js` | **Extend** |
| `backend/src/modules/identity/adminPasswordReset.routes.js` | **New:** `POST /users/:userId/reset-password` |
| `backend/src/modules/identity/adminPasswordReset.routes.test.js` | **New** |
| `backend/src/modules/auth/index.js` | **Extend:** export the reset-status read model for Phase 11 |
| `backend/src/http/routes.js` | Register the new route modules |

## 9. Tests (≥ 80% line and branch)

### Unit

- The policy accepts a compliant password and returns `TOO_SHORT` below the minimum.
- The policy returns `SAME_AS_CURRENT` when the candidate matches the stored hash.
- The policy returns `RECENTLY_USED` for a hash in history, and skips the check when
  `PASSWORD_HISTORY_LENGTH` is `0`.
- `passwordHistory` is capped at `PASSWORD_HISTORY_LENGTH`, oldest entry dropped first.
- The reset-status read model is `none` or `completed` from `passwordUpdatedAt` (no pending token).

### Integration (`app.inject`, Phase 03 database harness)

- Self change with the correct current password returns `200`, and the previously issued
  access token is rejected on the next request.
- Self change revokes every `sessions` row for that user.
- Admin set-password for a user in the same organization returns `200` with `state: 'completed'`
  and does not echo `newPassword`.
- Admin set-password moves an `invited` user to `active`.

### Unhappy paths that must be covered

- Self change with the wrong current password returns `403` and does not revoke sessions.
- Admin set-password for a user in another organization returns `404`.
- Admin set-password without `users.manage` returns `403`.
- Admin set-password targeting the caller returns `409`.
- No response, error or log line contains a password or a hash — asserted by a
  test scanning the captured log output.

## 10. Definition of Done

- [ ] Both write paths go through one transactional `applyNewPassword`.
- [ ] There is no public forgot/reset-token route and no `passwordResetTokens` collection (D15).
- [ ] Every password change revokes all of that user's sessions and writes `passwordUpdatedAt`,
      making outstanding access tokens fail on their next request.
- [ ] The admin reset route resolves the target inside the caller's organization only and
      returns `404` for anyone outside it.
- [ ] The administrator response never echoes `newPassword` and never implies an email was sent
      (D15, solution §14).
- [ ] No token value or password hash appears in any response, log line or audit context.
- [ ] Rate-limit class and audit hook points are declared for Phases 12 and 10.
- [ ] No new `.env` keys. Password policy numbers are constants.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/data-model.md`: add `users.passwordHistory` only (no reset-token collection).
- `docs/adr/`: record D15 (admin-mediated reset; no public token flow) as an ADR in this phase.
  README §5 already places email/SMS out of scope; D15 is not a scope change.
- `backend/solution.md` §8.3: replace "user self-reset via one-time token" with
  "administrator sets `newPassword`; secret never returned; user receives it out of band".

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **How does a user receive a new password?** **Decided (D15).** No public forgot. The
   administrator sets `newPassword` in `POST /users/:userId/reset-password` and communicates it
   out of band. The secret is never returned in the API response.
2. **Password minimum length.** Left unset on purpose. What is the required minimum, and is
   there an organization-configurable override?
3. **Password history.** Should reuse be blocked at all, and if so over how many previous
   passwords? Every entry costs one argon2 verification per change, and storing old hashes is
   additional sensitive data to protect (backend §147).
4. **Must-change-on-next-login after admin set.** Proposed: no extra flag in this slice; the
   user can sign in with the admin-set password and change it via `POST /auth/password/change`.
   Confirm.
5. **Does an administrator-initiated reset disable the account until the reset completes?**
   Leaving the old password working means the reset is advisory; forcing `userStatus: 'invited'`
   locks out a user whose administrator clicked by mistake. Which behaviour is wanted?
6. **Should an administrator's reset revoke the target's sessions immediately**, or only when
   the new password is set? Immediate revocation is the safer answer for a suspected
   compromise, which is the main reason an administrator resets someone's password.
7. **Who may reset whose password?** Backend §5 says "permitted users". Is `users.manage`
   sufficient for every target, including another `org_admin`? Should an administrator be able
   to reset their own password through the admin route (currently `409`)?
8. **Scope check.** **Decided (D15).** Email is out of scope. Do not add a channel in this
   phase. Remaining open items: minimum length, history, must-change-on-next-login.
