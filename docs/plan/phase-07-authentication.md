# Phase 07 — Authentication: argon2 passwords, JWT access & refresh

- **Layer:** BE
- **Depends on:** Phase 06 (identity collections)
- **Unblocks:** Phase 08, 09, 13
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §5 (user authentication), §88 (security),
  §90 (API authorization), §148 (secret protection), §149 (logging), §152 (authoritative
  backend state); `frontend/requirments.md` §7A (authentication and session), §105.31 (session
  expiry gates protected content); `backend/solution.md` §8.3 (auth), §13.1 (auth rate-limit
  class); `docs/architecture.md` §3 (JWT → org + user on every protected route)

## 1. Goal

After this phase a seeded user can sign in and stay signed in. The backend hashes passwords
with argon2id, issues a short-lived JWT access token plus a rotating refresh token, exposes
`/api/v1/auth/login`, `/refresh`, `/logout` and `/me`, and attaches a verified principal
(`organizationId`, `userId`, `roleIds`, `sessionId`) to every authenticated request.

You can see it working with three curl calls: login returns an access token and a user
summary; `/me` with that token returns the same summary and returns `401` without it; refresh
returns a new pair and makes the presented refresh token unusable. Nothing in the responses or
the logs contains a password, a hash or a token value.

## 2. Why this phase is here

Phase 06 created users but nothing can act as one. Every phase from 09 onward assumes
`request.principal` exists, and the RBAC engine has nothing to authorize without it. The
frontend API client (Phase 13) needs the token lifecycle contract before it can decide how to
attach credentials and how to react to expiry.

It cannot come earlier because there is no `User` row to authenticate against, and it must
come before Phase 08: password change and reset are only meaningful once sessions exist to
invalidate.

## 3. Scope

### In scope

- An argon2id hashing module: `hashPassword`, `verifyPassword`, `needsRehash`, with cost
  parameters read from named constants.
- JWT access tokens signed and verified through `@fastify/jwt`, with a short TTL.
- Opaque refresh tokens stored hashed in a new `sessions` collection, with rotation on every
  use and reuse detection that revokes the whole session family.
- `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`,
  `GET /api/v1/auth/me`.
- An `authenticate` Fastify `preHandler` that verifies the token, loads the user, rejects
  non-active users, and decorates `request.principal`.
- Uniform failure responses that do not reveal whether an email exists, is invited, or is
  disabled.
- Extending the Phase 06 seed script so the bootstrap administrator can be given a password
  (see Phase 06 §12 question 1).
- Log redaction entries for `password`, `newPassword`, `accessToken`, `refreshToken`,
  `passwordHash` and the `authorization` and `cookie` headers.

### Out of scope (owner phase)

- Rate limiting on the auth route class (solution §13.1 proposes 10/min per user, stricter per
  IP) — **Phase 12**. Leave the hook: register every auth route with
  `config: { rateLimitClass: 'auth' }` so Phase 12 attaches limits by class rather than
  editing each route.
- Audit events for login success, login failure, logout and refresh-reuse detection —
  **Phase 10**. Leave the hook: the auth service returns a typed outcome
  (`authenticated` | `invalid_credentials` | `not_permitted` | `reuse_detected`) that Phase 10
  maps to `AuditEvent` rows, so the audit call site is one function, not six.
- Permission resolution and `requirePermissions` — **Phase 09**. This phase resolves *who* the
  caller is, never *what* they may do.
- Password change, forgot and reset — **Phase 08**.
- The frontend session handling described in frontend §7A — **Phase 14**.
- Project-scoped authorization — **Phase 18**.

## 4. Design

### 4.1 Password hashing

`src/modules/auth/passwordHasher.js` is the only module that imports `argon2`. It always uses
the argon2id variant (solution §8.3) and takes memory cost, time cost and parallelism from
named constants in `passwordHasher.ts`. Raising them is a code change, not an env change.

`verifyPassword` never short-circuits on a missing user. When the email is unknown, or the
user has no `passwordHash` because they are still `invited`, the login path still runs a
verification against a fixed dummy hash generated once at boot, then fails. Without this,
response time alone tells an attacker which emails exist.

On a successful login, if `needsRehash` reports that the stored hash used weaker parameters
than the current constants, the hash is recomputed and written back. This is the only
place a password hash is written outside Phase 08.

The concrete cost parameters are **not** proposed here — see section 12. They must be chosen
against the argon2 maintainers' current guidance and measured on the target hardware, not
guessed in a plan document.

### 4.2 Tokens

Two tokens with deliberately different properties:

| | Access token | Refresh token |
|---|---|---|
| Format | Signed JWT (`@fastify/jwt`) | Opaque random bytes, base64url |
| Lifetime | Short, minutes (named constants) | Long, days (named constants) |
| Stored server-side | No | Yes, SHA-256 hash only |
| Revocable before expiry | Only via the checks in §4.4 | Yes, immediately |
| Sent on | Every request, `Authorization: Bearer` | Only to `/auth/refresh` and `/auth/logout`, via httpOnly cookie (D14) |

Access token claims are deliberately minimal:

```text
sub  userId          org  organizationId      sid  sessionId
rls  roleIds[]       typ  'access'            iss / aud / iat / exp
```

`rls` carries role ids, not permissions. Permissions change when an administrator edits a role,
and a token that carried them would keep granting access until it expired. Phase 09 resolves
permissions per request from the role ids.

The refresh token value is never stored. The `sessions` collection stores its SHA-256 hash, so
a database read cannot be replayed as a login. SHA-256 is correct here and argon2 is not: the
token is 256 bits of server-generated randomness, so there is nothing to brute-force, and the
refresh path must stay fast.

### 4.3 Rotation and reuse detection

Every successful refresh consumes the presented token and issues a new one in the same
*family* (`familyId`, set at login). The consumed row keeps `rotatedAt` and the id of its
successor.

If a token that has already been rotated is presented again, that means the value leaked — the
legitimate client and an attacker now both hold tokens from one family. The response is not
just a rejection: every session row in that family is revoked with
`revokedReason: 'reuse_detected'`, forcing a fresh login. This is the standard defence for
rotating refresh tokens and it is the reason rotation is worth the extra collection.

### 4.4 Principal resolution

`authenticate` runs as a `preHandler` on every protected route:

```text
1. read the bearer token; missing or malformed        → 401 UNAUTHENTICATED
2. verify signature, issuer, audience, expiry         → 401 SESSION_EXPIRED on expiry
                                                        401 UNAUTHENTICATED otherwise
3. load the user by sub, scoped to the org claim, status 'A'
   missing                                            → 401 UNAUTHENTICATED
   userStatus !== 'active'                            → 401 UNAUTHENTICATED
4. reject if user.passwordUpdatedAt > token iat       → 401 SESSION_EXPIRED   (Phase 08 relies on this)
5. request.principal = { userId, organizationId, roleIds, sessionId }
```

Two distinct `401` codes matter to the UI. `SESSION_EXPIRED` tells the frontend to attempt a
silent refresh and, failing that, to return the user to sign-in preserving their route
(frontend §7A, §105.31). `UNAUTHENTICATED` means do not retry. Neither code reveals anything
about another account.

Step 3 costs one indexed read per request. That is accepted: it is what makes deactivation
(Phase 11) and password change (Phase 08) take effect immediately instead of at token expiry.
Phase 09 adds caching for the role→permission lookup, which is the part that is safe to cache.

`request.principal.organizationId` comes from the verified token and from nowhere else. No
route may take a tenant scope from a path, query or body parameter — Phase 09 makes that a
enforced convention, but the principal shape established here is what makes it possible.

### 4.5 Uniform failure

Login returns exactly one failure shape — `401` with code `INVALID_CREDENTIALS` — for all of:
unknown email, wrong password, `userStatus: 'invited'`, `userStatus: 'disabled'`, and
`status: 'D'`. The message is the same string in every case. Distinguishing them would turn
the login form into an account-enumeration oracle and would tell an attacker which accounts are
worth attacking.

The internal reason is still needed for support and for the Phase 10 audit trail, so the auth
service returns it as a typed outcome that is logged at `info` with the *email hash*, never the
email or the password, and never returned to the client (backend §148, §149).

### 4.6 Session and logout

`POST /auth/logout` revokes the current session (and, by extension, its family). It always
returns `204`, even when the refresh token is already unknown — logout must never fail in a way
that leaves a client believing it is still signed in. Access tokens issued for that session
remain syntactically valid until they expire; the `sid` claim allows a future revocation check
if the residual window proves unacceptable (section 12).

## 5. Data model changes

One new collection, `sessions`, on the Phase 03 base schema.

| Field | Type | Notes |
|---|---|---|
| `organizationId` | ObjectId, required | Tenant scope |
| `userId` | ObjectId, required | Owner |
| `familyId` | string, required | Shared by every rotation of one login |
| `refreshTokenHash` | string, required | SHA-256 of the opaque token; the value itself is never stored |
| `issuedAt` | Date, required | UTC |
| `expiresAt` | Date, required | UTC; absolute expiry of the refresh token |
| `rotatedAt` | Date, optional | Set when consumed by a refresh |
| `replacedBySessionId` | ObjectId, optional | Successor in the family |
| `revokedAt` | Date, optional | Set on logout, reuse detection, or password change |
| `revokedReason` | `'logout' \| 'reuse_detected' \| 'password_changed' \| 'user_disabled'`, optional | |
| `status` | `'A' \| 'D'` | Row visibility; retention (Phase 60) tombstones old rows |

Indexes: unique `{ refreshTokenHash: 1 }`; `{ organizationId: 1, userId: 1, status: 1 }` for
"revoke all sessions of this user" (Phase 08); `{ familyId: 1 }` for reuse-driven family
revocation; `{ expiresAt: 1 }` for the Phase 60 cleanup sweep.

Existing `users` fields written by this phase: `passwordHash`, `passwordUpdatedAt` (when a
rehash occurs), `lastLoginAt`.

## 6. API contract — PROPOSED (needs approval before implementation)

All four routes are unauthenticated at the transport level except `/me`, and all belong to the
`auth` rate-limit class (Phase 12).

### `POST /api/v1/auth/login`

- **Auth:** none. **Permission:** none.

```json
{ "email": "admin@acme.example", "password": "<user supplied>" }
```

Response `200`:

```json
{
  "accessToken": "<jwt>",
  "accessTokenExpiresInSeconds": 900,
  "user": {
    "id": "6712f0b1c9a41d2f8e4b3a02",
    "email": "admin@acme.example",
    "displayName": "Acme Administrator",
    "organizationId": "6712f0b1c9a41d2f8e4b3a01",
    "roleIds": ["6712f0b1c9a41d2f8e4b3a03"]
  }
}
```

The refresh token is **not** in this body (**D14**). It is set as `Set-Cookie`:
`HttpOnly; SameSite=Strict; Path=/api/v1/auth; Secure` in production. A readable CSRF cookie
is set alongside it; the client echoes it as `X-CSRF-Token` on refresh and logout.

Errors: `400 VALIDATION_ERROR` (zod, missing or malformed field);
`401 INVALID_CREDENTIALS` (every rejected case, §4.5); `429 RATE_LIMITED` (Phase 12).

### `POST /api/v1/auth/refresh`

- **Auth:** the refresh token (body field or cookie, per section 12).

```json
{ "refreshToken": "<opaque>" }
```

Response `200`: same shape as login. Errors: `401 SESSION_EXPIRED` (unknown, expired, revoked
or already-rotated token — uniform, and reuse additionally revokes the family);
`429 RATE_LIMITED`.

### `POST /api/v1/auth/logout`

- **Auth:** the refresh token; the access token is optional.
- Response `204`, always, with no body.

### `GET /api/v1/auth/me`

- **Auth:** access token. **Permission:** none beyond authentication.

Response `200`:

```json
{
  "id": "6712f0b1c9a41d2f8e4b3a02",
  "email": "admin@acme.example",
  "displayName": "Acme Administrator",
  "organizationId": "6712f0b1c9a41d2f8e4b3a01",
  "roleIds": ["6712f0b1c9a41d2f8e4b3a03"]
}
```

Errors: `401 UNAUTHENTICATED`, `401 SESSION_EXPIRED`.

Phase 09 extends this body with the caller's effective permission list so the UI can decide
what to render; it is not included here because the catalog does not exist yet.

## 7. Configuration & environment variables

Only secrets that must differ per environment go in `.env`. Token lifetimes, issuer, audience,
and argon2 costs are named constants (`.cursor/rules/env-config.mdc`). Never print `.env`
contents. `JWT_ACCESS_TOKEN_SECRET` is a real secret: generate it per environment, never commit
a value, and never log it.

### Environment variables

| Variable | Example | Required | Purpose |
|---|---|---|---|
| `JWT_ACCESS_TOKEN_SECRET` | `<generated 32+ byte value>` | **yes** | Signing key for access tokens |
| `BOOTSTRAP_ADMIN_PASSWORD` | `<generated>` | only for the seed | First admin password; hashed by this phase |

Config validation must reject a missing or short `JWT_ACCESS_TOKEN_SECRET` and must not print
the value in the error message (Phase 01 §4.1 already requires this).

### Constants (not env)

Concrete argon2 costs are chosen in section 12 against current argon2 guidance; until then the
constant names and the JWT timings below are the recommended defaults.

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `JWT_ACCESS_TOKEN_TTL_SECONDS` | `900` | `modules/auth/tokenService.js` | Access-token lifetime |
| `JWT_REFRESH_TOKEN_TTL_SECONDS` | `1209600` | `modules/auth/tokenService.js` | Refresh-token absolute lifetime |
| `JWT_ISSUER` | `'codex-sage'` | `modules/auth/tokenService.js` | `iss` claim, verified on every request |
| `JWT_AUDIENCE` | `'codex-sage-api'` | `modules/auth/tokenService.js` | `aud` claim, verified on every request |
| `ARGON2_MEMORY_COST_KIB` | see section 12 | `modules/auth/passwordHasher.js` | argon2id memory cost |
| `ARGON2_TIME_COST` | see section 12 | `modules/auth/passwordHasher.js` | argon2id iterations |
| `ARGON2_PARALLELISM` | see section 12 | `modules/auth/passwordHasher.js` | argon2id lanes |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/package.json` | Add `argon2`, `@fastify/jwt`, `@fastify/cookie`, `@fastify/csrf-protection` after the `dependency-versions.mdc` pre-install checks |
| `backend/src/platform/config.js` | Add `auth.jwtAccessTokenSecret` (and optional bootstrap password) |
| `backend/src/platform/config.test.js` | **Extend:** missing secret, short secret |
| `backend/src/platform/logger.js` | **Extend:** redaction paths for credentials and tokens |
| `backend/src/platform/logger.test.js` | **Extend:** assert redaction of each path |
| `backend/src/modules/auth/passwordHasher.js` | **New:** hash, verify, needsRehash |
| `backend/src/modules/auth/passwordHasher.test.js` | **New** |
| `backend/src/modules/auth/tokenService.js` | **New:** sign/verify access tokens, mint refresh tokens |
| `backend/src/modules/auth/tokenService.test.js` | **New** |
| `backend/src/modules/auth/session.model.js` | **New:** `sessions` schema and indexes |
| `backend/src/modules/auth/session.repository.js` | **New:** create, findByHash, rotate, revoke, revokeFamily, revokeAllForUser |
| `backend/src/modules/auth/session.repository.test.js` | **New** |
| `backend/src/modules/auth/auth.service.js` | **New:** login, refresh, logout as typed outcomes |
| `backend/src/modules/auth/auth.service.test.js` | **New** |
| `backend/src/modules/auth/auth.routes.js` | **New:** the four routes, zod-validated |
| `backend/src/modules/auth/auth.routes.test.js` | **New:** integration via `app.inject` |
| `backend/src/modules/auth/authenticate.preHandler.js` | **New:** principal resolution |
| `backend/src/modules/auth/authenticate.preHandler.test.js` | **New** |
| `backend/src/modules/auth/index.js` | **New:** public surface (`authenticate`, principal type) |
| `backend/src/http/routes.js` | Register `authRoutes` |
| `backend/src/http/app.js` | Register `@fastify/jwt`, `@fastify/cookie`, `@fastify/csrf-protection`; declare the `principal` request decorator |
| `backend/src/cli/bootstrap.js` | **Extend (Phase 06 file):** optional password for the first admin |
| `backend/.env.example` / `backend/.env` | Document and mirror `JWT_ACCESS_TOKEN_SECRET` and `BOOTSTRAP_ADMIN_PASSWORD` |

## 9. Tests (≥ 80% line and branch)

### Unit

- `hashPassword` output verifies with `verifyPassword` and differs across two calls (salted).
- `verifyPassword` returns false for a wrong password and for a malformed stored hash.
- `needsRehash` is true when the stored parameters are below the current constants.
- Access tokens carry `sub`, `org`, `rls`, `sid`, `iss`, `aud`, and no permission claim.
- Token verification rejects a wrong signature, a wrong issuer, a wrong audience and an
  expired token, with the expired case mapping to `SESSION_EXPIRED`.
- Refresh tokens are unique across many mints and are stored only as a hash.

### Integration (`app.inject`, Phase 03 database harness)

- Login with correct credentials returns `200` and a usable access token.
- `/me` with that token returns the user; without it returns `401 UNAUTHENTICATED`.
- Refresh returns a new pair, and the old refresh token then fails with `401 SESSION_EXPIRED`.
- Presenting an already-rotated token revokes every session in the family, so the newest
  token also stops working.
- Logout returns `204`, and refresh afterwards fails.
- Logout with an unknown refresh token still returns `204`.

### Unhappy paths that must be covered

- Unknown email, wrong password, `invited` user, `disabled` user and `status: 'D'` user all
  return byte-identical `401 INVALID_CREDENTIALS` bodies.
- A token whose `org` claim does not match the user's organization is rejected.
- A token with a valid signature for a soft-deleted user is rejected.
- A token issued before `passwordUpdatedAt` is rejected as `SESSION_EXPIRED` (the seam Phase 08
  depends on).
- No response body, error message or log line produced by any of these tests contains a
  password, a hash, an access token or a refresh token — asserted by a test that scans the
  captured log output.

## 10. Definition of Done

- [ ] Passwords are hashed with argon2id using the hasher constants; no plaintext is stored,
      logged or returned.
- [ ] Access tokens are short-lived, carry role ids rather than permissions, and are verified
      for issuer, audience and expiry.
- [ ] Refresh tokens are opaque, stored only as a SHA-256 hash, rotated on every use, and reuse
      revokes the family.
- [ ] `request.principal` is populated only from verified token claims plus a database read;
      never from a request parameter.
- [ ] All five rejected login cases return an identical response.
- [ ] `401` distinguishes `SESSION_EXPIRED` from `UNAUTHENTICATED` for the UI, without leaking
      account state.
- [ ] Every auth route declares `config: { rateLimitClass: 'auth' }` for Phase 12.
- [ ] The auth service returns typed outcomes at the single call site Phase 10 will audit.
- [ ] Log redaction covers password, token, hash and `authorization` / `cookie` headers, with a
      test proving it.
- [ ] `JWT_ACCESS_TOKEN_SECRET` (and `BOOTSTRAP_ADMIN_PASSWORD` for the seed) are documented in
      `backend/.env.example` and mirrored in `backend/.env`, with no real value committed.
      Argon2 costs and JWT lifetimes are constants, not env vars.
- [ ] `argon2`, `@fastify/jwt`, `@fastify/cookie` and `@fastify/csrf-protection` installed at
      latest stable after the pre-install checks (D14).
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/adr/`: record the refresh-token decision (rotation with reuse detection, and the
  transport chosen in section 12) as an ADR — it is a security-architecture decision with
  consequences for CSRF and for the frontend client in Phase 13. Phase 04 owns the stack ADRs;
  this one is specific enough to belong to this phase.
- `docs/data-model.md`: add the `sessions` collection.
- `docs/architecture.md` §3: the line "JWT → org + user" now has a concrete shape; state where
  the principal comes from.
- `backend/solution.md` §8.3: replace "httpOnly cookie or rotating store" with D14 (httpOnly
  refresh cookie + CSRF double-submit; access token in JSON / memory).

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Refresh-token transport.** **Decided (D14).** httpOnly cookie, `SameSite=Strict`,
   `Path=/api/v1/auth`, plus a CSRF double-submit header on refresh and logout. The access
   token stays in the JSON body and in browser memory only.
2. **argon2id cost parameters.** Deliberately left unset. They must come from current OWASP /
   argon2 guidance and be measured on the target hardware — a guessed memory cost is either
   insecure or a denial-of-service on the login route. Who provides the target numbers?
3. **Access-token TTL and refresh-token TTL.** The examples above (15 minutes, 14 days) are
   placeholders in a proposed contract, not a recommendation. Confirm both.
4. **Residual access-token validity after logout.** Logout revokes the session but an already
   issued access token stays valid until it expires. Acceptable with a short TTL, or should
   `authenticate` also check that `sid` is still active — one extra indexed read per request?
5. **Concurrent refresh.** Two browser tabs refreshing at the same moment will make the second
   look like token reuse and log everyone out. Mitigations: a short grace window during which
   the immediately preceding token is still accepted, or requiring the client to serialise
   refreshes. Which behaviour is wanted?
6. **Disabled user, honest message.** Uniform `INVALID_CREDENTIALS` means a deactivated
   employee sees "wrong email or password". Is that acceptable, or should a disabled account
   get a distinct message once the password has been verified correctly (which is safe, but
   only after a correct password)?
7. **Login attempt throttling and lockout.** Rate limiting (Phase 12) caps request volume; it
   is not per-account lockout. Is account lockout after N failures required, and if so, who
   unlocks?
8. **Session listing.** Should a user, or an administrator, be able to see and revoke active
   sessions? No phase currently owns that surface.
