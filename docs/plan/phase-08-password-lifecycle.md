# Phase 08 — Password lifecycle: self-service and admin-initiated reset

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
A signed-in user can change their own password; a user who has forgotten it can redeem a
one-time reset token; an administrator with `users.manage` can start a reset for someone in
their organization and see its status. Every one of those paths invalidates the affected
user's existing sessions.

You can see it working by changing your password through the API and watching the previously
issued access token stop being accepted on the next request, and by redeeming a reset token
once and getting a rejection the second time.

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
- Self-service forgot / reset with a one-time token that is hashed at rest, single-use and
  time-limited (solution §8.3).
- Administrator-initiated reset for a user in the administrator's organization, and the reset
  status the administrator is shown (frontend §84).
- Revocation of every session and every outstanding reset token for a user whenever their
  password changes, by any path.
- A password policy module: minimum length, a rejection of the current password, and the
  proposed history check.
- A read model (`passwordResetStatus`) that Phase 11 surfaces on the admin user detail.

### Out of scope (owner phase)

- **Delivering the reset token to the user.** There is no email or SMS channel in this slice
  (solution §14, README §5). Section 12 raises this as the blocking question; this phase must
  not invent a delivery mechanism.
- Rate limiting on the reset routes (solution §13.1 puts login and reset in one class at
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

### 4.1 Three entry points, one write path

All three flows converge on a single internal function that (1) validates the new password
against the policy, (2) hashes it with the Phase 07 hasher, (3) writes `passwordHash` and
`passwordUpdatedAt`, (4) sets `userStatus` to `active` if the user was `invited`, (5) revokes
every session for that user, and (6) consumes or invalidates every outstanding reset token.
Steps 3–6 run inside one transaction (decision D5), because a password written without the
session revocation is worse than no change at all.

```text
self change      → verify current password  ─┐
redeem token     → verify one-time token    ─┼→ applyNewPassword(userId, newPassword, reason)
admin initiate   → (issues a token; no write of a password)
```

An administrator never sets a password value directly. They create a reset token, and the user
completes the change. That keeps the invariant that no one but the account holder ever knows
the credential (backend §147, §148).

### 4.2 The one-time token

The token is 256 bits of cryptographically secure randomness, base64url-encoded, returned once
and never stored. The `passwordResetTokens` collection stores its SHA-256 hash, exactly as
Phase 07 stores refresh-token hashes and for the same reason: a database dump must not be
redeemable.

Redemption is a conditional update, not a read followed by a write:

```text
findOneAndUpdate(
  { tokenHash, status: 'A', usedAt: null, expiresAt: { $gt: now } },
  { $set: { usedAt: now } }
)
```

A `null` result means unknown, already used, or expired, and all three produce the same
response. Doing this as an atomic update is what makes the token genuinely single-use under
two concurrent redemptions.

Tokens carry a `purpose` of `self_service` or `admin_initiated` so the audit trail and the
status read model can tell them apart, but they redeem through the same endpoint.

### 4.3 Forgot: no enumeration, no oracle

`POST /auth/password/forgot` always returns `202` with the same body, whether the email is
unknown, belongs to a disabled user, or belongs to an active one. A token is created only in
the active case. This is the same reasoning as Phase 07 §4.5: the endpoint is unauthenticated,
so any variation in its response is an account-enumeration oracle.

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

`src/modules/auth/passwordPolicy.ts` validates a candidate password and returns a list of
violation codes rather than a sentence, so the UI can localise them (README §4, frontend i18n).

Proposed rules, all **PROPOSED** and all listed in section 12:

- Minimum length from configuration; no maximum below what argon2 accepts.
- Rejected if it equals the user's current password.
- Rejected if it matches one of the last *N* hashes in `passwordHistory`, with *N*
  configurable and `0` disabling the check.
- No composition rules (mandatory symbol classes), because they push users toward predictable
  substitutions; length is the control that matters.

`passwordHistory` stores only argon2 hashes, is capped at *N* entries, and is `select: false`
like `passwordHash`. Comparing a candidate against *N* stored hashes costs *N* argon2
verifications, so *N* must stay small — this is a real cost, not a free check.

## 5. Data model changes

### New collection: `passwordResetTokens`

On the Phase 03 base schema.

| Field | Type | Notes |
|---|---|---|
| `organizationId` | ObjectId, required | Tenant scope |
| `userId` | ObjectId, required | Target account |
| `tokenHash` | string, required | SHA-256 of the one-time token; the value is never stored |
| `purpose` | `'self_service' \| 'admin_initiated'` | Drives audit context and the status model |
| `requestedByUserId` | ObjectId, optional | Set for `admin_initiated` only |
| `expiresAt` | Date, required | UTC |
| `usedAt` | Date, optional | Set atomically on redemption |
| `invalidatedAt` | Date, optional | Set when superseded by a newer token or by a password change |
| `status` | `'A' \| 'D'` | Row visibility; Phase 60 retention tombstones old rows |

Indexes: unique `{ tokenHash: 1 }`; `{ organizationId: 1, userId: 1, createdAt: -1 }` for the
status read model; `{ expiresAt: 1 }` for the Phase 60 sweep.

### Changed collection: `users`

| Field | Type | Notes |
|---|---|---|
| `passwordHistory` | `[{ hash: string, changedAt: Date }]`, `select: false`, default `[]` | Capped at the configured length; only if the reuse check is confirmed (section 12) |

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

### `POST /api/v1/auth/password/forgot`

- **Auth:** none. **Permission:** none.

```json
{ "email": "user@acme.example" }
```

Response `202`, identical in every case:

```json
{ "accepted": true }
```

No field in this response may vary with whether the account exists.

### `POST /api/v1/auth/password/reset`

- **Auth:** none; the token is the credential. **Permission:** none.

```json
{ "token": "<one-time token>", "newPassword": "<user supplied>" }
```

Response `200`:

```json
{ "passwordChanged": true, "reauthenticationRequired": true }
```

Errors: `400 VALIDATION_ERROR`; `401 RESET_TOKEN_INVALID` (unknown, used or expired — one
code for all three); `422 PASSWORD_POLICY_VIOLATION`; `429 RATE_LIMITED`.

### `POST /api/v1/users/:userId/reset-password`

- **Auth:** access token. **Permission:** `users.manage` (enforced by Phase 09).

Request body: empty, or `{}`.

Response `200`:

```json
{
  "userId": "6712f0b1c9a41d2f8e4b3a02",
  "email": "user@acme.example",
  "resetStatus": {
    "state": "pending",
    "requestedAt": "2026-05-04T09:12:00.000Z",
    "expiresAt": "2026-05-04T10:12:00.000Z",
    "completedAt": null
  },
  "deliveryChannel": "TBD — see section 12, question 1"
}
```

Errors: `401 UNAUTHENTICATED`; `403 FORBIDDEN` (missing `users.manage`); `404 NOT_FOUND` (no
such user in the caller's organization, or the user is soft-deleted); `409 CONFLICT` (target
is the caller — self-service is the correct route); `429 RATE_LIMITED`.

Whether this response also carries the token value is the open question in section 12. It is
deliberately absent from the proposal above: returning a credential for another account in an
API response is exactly what backend §148 forbids, and it must be an explicit, recorded
decision if it happens at all.

## 7. Configuration & environment variables

Add to `backend/.env.example` **and** mirror into `backend/.env`.

| Variable | Example | Required | Purpose |
|---|---|---|---|
| `PASSWORD_RESET_TOKEN_TTL_SECONDS` | `3600` | no | Lifetime of a one-time reset token |
| `PASSWORD_MIN_LENGTH` | see section 12 | **yes** | Minimum accepted password length |
| `PASSWORD_HISTORY_LENGTH` | see section 12 | no | Number of previous hashes checked; `0` disables |

No new secret is introduced. The reset token is generated per request and never stored in
configuration.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/platform/config.ts` | Extend the `auth` group with the password-policy settings |
| `backend/src/platform/config.test.ts` | **Extend:** new variables, defaults, invalid values |
| `backend/src/platform/logger.ts` | **Extend:** redact `currentPassword`, `newPassword`, `token` |
| `backend/src/modules/auth/passwordPolicy.ts` | **New:** validation returning violation codes |
| `backend/src/modules/auth/passwordPolicy.test.ts` | **New** |
| `backend/src/modules/auth/passwordResetToken.model.ts` | **New:** schema and indexes |
| `backend/src/modules/auth/passwordResetToken.repository.ts` | **New:** issue, redeem atomically, invalidate, latest-for-user |
| `backend/src/modules/auth/passwordResetToken.repository.test.ts` | **New** |
| `backend/src/modules/auth/password.service.ts` | **New:** change, forgot, reset, admin initiate, `applyNewPassword` |
| `backend/src/modules/auth/password.service.test.ts` | **New** |
| `backend/src/modules/auth/password.routes.ts` | **New:** the three `/auth/password/*` routes |
| `backend/src/modules/auth/password.routes.test.ts` | **New** |
| `backend/src/modules/identity/user.model.ts` | **Extend:** `passwordHistory` |
| `backend/src/modules/identity/user.repository.ts` | **Extend:** write hash + history + `passwordUpdatedAt` in one update |
| `backend/src/modules/identity/user.repository.test.ts` | **Extend** |
| `backend/src/modules/identity/adminPasswordReset.routes.ts` | **New:** `POST /users/:userId/reset-password` |
| `backend/src/modules/identity/adminPasswordReset.routes.test.ts` | **New** |
| `backend/src/modules/auth/index.ts` | **Extend:** export the reset-status read model for Phase 11 |
| `backend/src/http/routes.ts` | Register the new route modules |
| `backend/.env.example` / `backend/.env` | Document and mirror the new variables |

## 9. Tests (≥ 80% line and branch)

### Unit

- The policy accepts a compliant password and returns `TOO_SHORT` below the minimum.
- The policy returns `SAME_AS_CURRENT` when the candidate matches the stored hash.
- The policy returns `RECENTLY_USED` for a hash in history, and skips the check when
  `PASSWORD_HISTORY_LENGTH` is `0`.
- `passwordHistory` is capped at the configured length, oldest entry dropped first.
- Generated reset tokens are unique across many calls and are stored only as hashes.
- The reset-status read model maps token rows to `none`, `pending`, `completed` and `expired`.

### Integration (`app.inject`, Phase 03 database harness)

- Self change with the correct current password returns `200`, and the previously issued
  access token is rejected on the next request.
- Self change revokes every `sessions` row for that user.
- Forgot for an existing active user creates exactly one active token.
- A second forgot invalidates the first token.
- Reset redeems the token, changes the password, and the same token then fails.
- Reset moves an `invited` user to `active`.
- Admin reset for a user in the same organization returns `200` with `state: 'pending'`.

### Unhappy paths that must be covered

- Forgot for an unknown email, a disabled user and a soft-deleted user all return byte-
  identical `202` bodies, and none creates a token.
- Reset with an expired token, a used token and an unknown token all return
  `401 RESET_TOKEN_INVALID`.
- Two concurrent redemptions of the same token: exactly one succeeds.
- Self change with the wrong current password returns `403` and does not revoke sessions.
- Admin reset for a user in another organization returns `404`, and the target's tokens are
  untouched.
- Admin reset without `users.manage` returns `403`.
- Admin reset targeting the caller returns `409`.
- No response, error or log line contains a reset token, a password or a hash — asserted by a
  test scanning the captured log output.

## 10. Definition of Done

- [ ] All three write paths go through one transactional `applyNewPassword`.
- [ ] Reset tokens are single-use, time-limited, hashed at rest, and redeemed by an atomic
      conditional update.
- [ ] `POST /auth/password/forgot` is indistinguishable across existing, disabled and unknown
      accounts.
- [ ] Every password change revokes all of that user's sessions and writes `passwordUpdatedAt`,
      making outstanding access tokens fail on their next request.
- [ ] The admin reset route resolves the target inside the caller's organization only and
      returns `404` for anyone outside it.
- [ ] The administrator response states the reset status and the delivery channel truthfully;
      it never implies an email was sent (solution §14).
- [ ] No token value or password hash appears in any response, log line or audit context.
- [ ] Rate-limit class and audit hook points are declared for Phases 12 and 10.
- [ ] New variables are documented in `backend/.env.example` and mirrored in `backend/.env`.
- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/data-model.md`: add `passwordResetTokens` and the `users.passwordHistory` field.
- `docs/adr/`: once question 1 is answered, record the reset-delivery decision as an ADR. It
  determines whether the product needs an email channel, which README §5 currently places out
  of scope for the whole plan — that is a scope change, not an implementation detail.
- `backend/solution.md` §8.3: replace "user self-reset via one-time token" with the concrete
  delivery mechanism once it is agreed.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **How does a user actually receive a self-service reset token?** This is the blocking
   question for the phase. Solution §14 and README §5 exclude email and SMS from this slice, so
   `POST /auth/password/forgot` currently creates a token that reaches nobody. The options, none
   of which may be chosen without the product owner:
   - **Admin-mediated only:** drop the self-service forgot endpoint from this slice entirely; a
     user who forgets their password contacts an administrator, who starts a reset. The
     administrator then still needs a way to pass the token to the user.
   - **Token returned to the administrator:** `POST /users/:id/reset-password` returns the
     one-time token in its response for the administrator to relay out of band. This is
     workable but it puts another account's credential in an API response and in the browser,
     which backend §148 otherwise forbids. It needs an explicit exception and an ADR.
   - **Add an email channel:** the clean product answer, but it contradicts solution §14 and
     README §5 and adds a mail provider, a template surface and a deliverability concern —
     a plan-level scope change, not a phase-level one.
   Until this is answered, the `deliveryChannel` field in section 6 has no value and the
   self-service flow cannot be shipped end to end. **Do not pick a default.**
2. **Password minimum length.** Left unset on purpose. What is the required minimum, and is
   there an organization-configurable override?
3. **Password history.** Should reuse be blocked at all, and if so over how many previous
   passwords? Every entry costs one argon2 verification per change, and storing old hashes is
   additional sensitive data to protect (backend §147).
4. **Reset-token lifetime.** One hour is proposed as a placeholder. Confirm.
5. **Does an administrator-initiated reset disable the account until the reset completes?**
   Leaving the old password working means the reset is advisory; forcing `userStatus: 'invited'`
   locks out a user whose administrator clicked by mistake. Which behaviour is wanted?
6. **Should an administrator's reset revoke the target's sessions immediately**, or only when
   the new password is set? Immediate revocation is the safer answer for a suspected
   compromise, which is the main reason an administrator resets someone's password.
7. **Who may reset whose password?** Backend §5 says "permitted users". Is `users.manage`
   sufficient for every target, including another `org_admin`? Should an administrator be able
   to reset their own password through the admin route (currently `409`)?
8. **Scope check.** If the email channel in question 1 turns out to be in scope, this phase
   grows past the 1–2 day target and the channel should be split into its own phase rather than
   absorbed here.
