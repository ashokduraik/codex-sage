# Phase 12 — Rate limiting & idempotency

- **Layer:** BE
- **Depends on:** Phase 09 (authenticated principal for per-user keys), Phase 02 (`RATE_LIMITED`
  catalog entry), Phase 03 (base schema, test harness)
- **Unblocks:** Phase 17 (create `Idempotency-Key`), Phase 22 (retry), Phase 23–24 (upload),
  Phase 30 (probe), later mutating/async starts
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §91, §92; `backend/solution.md` §13;
  `docs/architecture.md` §10; plan decision D13

## 1. Goal

After this phase every route declares a **rate-limit class**, `@fastify/rate-limit` enforces
per-class budgets (user id when authenticated, otherwise IP), a `429` uses
`code: RATE_LIMITED` with `retryAfterSec`, and mutating/async starts honour an
`Idempotency-Key` header against an `IdempotencyRecord` collection so a retried click does
not create a second user, project, upload, or job.

You can see it working by calling login more than the auth class allows and receiving `429`
with a structured body, and by sending the same `Idempotency-Key` on two `POST /users`
creates (once Phase 11 is wired — a test route or the existing create is enough) and getting
the same stored response the second time.

## 2. Why this phase is here

Auth routes (Phase 07/08) already declare `config: { rateLimitClass: 'auth' }` as a hook.
Without this phase those declarations do nothing. Upload, job retry, and admin creates
cannot be safe against double-submit until the idempotency middleware exists. It follows
Phase 09 so authenticated limit keys use `principal.userId` rather than only IP (which
would punish NAT). It follows Phase 03 so `IdempotencyRecord` uses the base schema and the
test harness.

It cannot come later than the first public mutating route that solution §13.2 lists; Phase
11's user create is already in the tree, so this phase should land before Phase 17 at the
latest and is sequenced here so 11 can be retro-fitted in the same PR or immediately after.

## 3. Scope

### In scope

- `@fastify/rate-limit` registered once on the Fastify instance.
- Route `config.rateLimitClass` → named constant budgets (not env — **D13**, despite
  solution §13.1 saying "tunable via env").
- `429` envelope: `{ error: { code: 'RATE_LIMITED', message, details: { retryAfterSec } } }`
  plus `Retry-After` header.
- `IdempotencyRecord` collection and middleware for mutating/async starts.
- Concurrent duplicate keys: first writer wins; the second waits or receives the stored
  response (no second resource).
- Retro-fit of Phase 07/08/11 routes that already declared a class or need a key.

### Out of scope (owner phase)

- Per-organization override of budgets — later org config; not env, not this slice.
- Account lockout after N failed logins — Phase 07 §12, not rate limiting.
- Frontend retry/`Retry-After` UX — **Phase 13** already maps `429`; screens consume it
  as they are rewired.
- Idempotency on safe GETs.

## 4. Design

### 4.1 Rate-limit classes

Plugin reads `request.routeOptions.config.rateLimitClass`. Unknown or missing class on a
non-probe route is a **startup or test failure** — do not silently unlimited-allow. Health
and readiness stay in class `none` (no limit).

Key: `userId` when `request.principal` exists, else client IP. Auth class uses IP even when
a body email is present (otherwise an attacker picks unlimited identities).

Solution §13.1 table, stored as constants:

| Class | Constant | Per key / 60s | Typical routes |
|---|---|---|---|
| `auth` | `RATE_LIMIT_AUTH_PER_MIN` | `10` | login, password change, admin set-password |
| `upload` | `RATE_LIMIT_UPLOAD_PER_MIN` | `6` | source upload |
| `chat` | `RATE_LIMIT_CHAT_PER_MIN` | `20` | SSE start / message create |
| `search` | `RATE_LIMIT_SEARCH_PER_MIN` | `60` | search, knowledge browse |
| `repo_sync` | `RATE_LIMIT_REPO_SYNC_PER_MIN` | `10` | manual sync trigger |
| `admin_mutate` | `RATE_LIMIT_ADMIN_MUTATE_PER_MIN` | `30` | user/project/role writes |
| `none` | — | unlimited | health, readiness |

IP-stricter auth: same class, additional in-memory/IP ceiling
`RATE_LIMIT_AUTH_IP_PER_MIN` (`20`) so a NAT is not a single-user lockout while still
bounding password guessing from one address. Exact IP ceiling is a constant, not env.

### 4.2 Idempotency middleware

Clients send `Idempotency-Key` (header name exact) on:

| Operation | Owner phase | Behaviour |
|---|---|---|
| Admin user create | 11 | replay `201` body; one user |
| Project create | 17 | replay `201`; one project |
| Upload / sourceVersion | 24 | replay `202 { sourceVersionId, jobId }` |
| Job retry / reingest / repo sync | 22, 29, 32 | existing active job |
| Chat message create | 41 | existing message id |

Key uniqueness: `{ orgId, userId, route, key }` while `status: 'A'` and
`expiresAt > now`. Store `responseStatus`, `responseBodyHash`, `resourceId`, serialized
body needed for replay (capped size constant). TTL `IDEMPOTENCY_RECORD_TTL_MS` = 24h;
a sweeper or TTL index removes expired rows (soft-delete `status: 'D'` or expire —
**proposed:** Mongo TTL index on `expiresAt` is allowed here because these rows are not
user-facing resources; record the choice in §12).

**Required vs optional:** solution §13.2 says clients send the header. Proposed: required
on the operations in the table; missing header → `400 IDEMPOTENCY_KEY_REQUIRED`. Confirm
in §12.

Concurrent duplicates: insert the record in `processing` state first; the loser waits up
to `IDEMPOTENCY_WAIT_MS` then reads the winner's stored response, or `409 IDEMPOTENCY_IN_FLIGHT`
if still processing.

Mismatched payload for an existing key → `409 IDEMPOTENCY_KEY_REUSE`.

### 4.3 Error codes

Phase 02 already reserved `RATE_LIMITED`. This phase registers (if missing):
`IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_REUSE`, `IDEMPOTENCY_IN_FLIGHT`.

Handlers still own `reply`. Middleware either throws `ApiError` or returns stored payload
to the route wrapper; it does not call `reply.send` if that would steal the handler's
response — prefer throwing a typed `IdempotencyReplay` that the on-send hook writes once
at the handler boundary. Implementation must obey `function-design.mdc` (no passing
`reply` into helpers).

## 5. Data model changes

### `idempotencyRecords`

| Field | Type | Notes |
|---|---|---|
| `orgId` | ObjectId | tenant key |
| `userId` | ObjectId | caller |
| `route` | string | method + path template |
| `key` | string | client header, max length constant |
| `requestHash` | string | hash of canonical body; detect reuse with different payload |
| `recordState` | `'processing' \| 'completed'` | domain lifecycle, not row `status` |
| `responseStatus` | number \| null | set when completed |
| `responseBody` | object \| null | capped replay payload |
| `resourceId` | ObjectId \| null | created resource |
| `expiresAt` | Date | UTC |
| `status` | `'A' \| 'D'` | default `'A'` |
| `createdAt` / `updatedAt` | Date | UTC |

Indexes: unique `{ orgId, userId, route, key }` partial `status: 'A'`;
`{ expiresAt: 1 }` (TTL if approved). Declared on the schema; synced via Phase 03
`syncSchemaIndexes`.

## 6. API contract — PROPOSED (needs approval before implementation)

No new resource paths. Cross-cutting:

- Header `Idempotency-Key`: 8–128 chars `[A-Za-z0-9._-]`.
- `429`:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Try again shortly.",
    "details": { "retryAfterSec": 12 }
  }
}
```

Header `Retry-After: 12`. `X-Correlation-Id` still present (Phase 02).

## 7. Configuration & environment variables

**None.** Budgets, key length, TTL, and wait are constants (D13). `process.env` is not
read here. Solution §13.1's "tunable via env" is **not** followed.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | `60000` | `platform/rateLimit.constants.js` | Window |
| `RATE_LIMIT_AUTH_PER_MIN` | `10` | same | Auth class |
| `RATE_LIMIT_AUTH_IP_PER_MIN` | `20` | same | Auth IP ceiling |
| `RATE_LIMIT_UPLOAD_PER_MIN` | `6` | same | Upload class |
| `RATE_LIMIT_CHAT_PER_MIN` | `20` | same | Chat class |
| `RATE_LIMIT_SEARCH_PER_MIN` | `60` | same | Search class |
| `RATE_LIMIT_REPO_SYNC_PER_MIN` | `10` | same | Sync trigger |
| `RATE_LIMIT_ADMIN_MUTATE_PER_MIN` | `30` | same | Admin writes |
| `IDEMPOTENCY_KEY_MAX_LENGTH` | `128` | `platform/idempotency.constants.js` | Header cap |
| `IDEMPOTENCY_RECORD_TTL_MS` | `86400000` | same | 24h |
| `IDEMPOTENCY_WAIT_MS` | `5000` | same | Wait for in-flight twin |
| `IDEMPOTENCY_BODY_MAX_BYTES` | `65536` | same | Stored replay cap |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/package.json` | Add `@fastify/rate-limit` after `dependency-versions.mdc` checks |
| `backend/src/platform/rateLimit.constants.js` | **New:** class budgets |
| `backend/src/platform/rateLimit.js` | **New:** plugin registration + key generator |
| `backend/src/platform/rateLimit.test.js` | **New:** class mapping, IP vs user key |
| `backend/src/platform/idempotency.constants.js` | **New** |
| `backend/src/modules/platform/idempotency/` | **New:** model, repository, middleware, tests |
| `backend/src/http/app.js` | Register rate-limit plugin |
| `backend/src/platform/errorCatalog.js` | Add/confirm codes |
| Existing auth/admin routes | Enforce class + required key on creates |

## 9. Tests (≥ 80% line and branch)

### Unit

- Class → max mapping; missing class on a protected route fails fast in tests.
- Key uses `userId` when principal exists, IP otherwise; auth class always IP for login.
- Idempotency key validation (too short, illegal chars).
- Request hash mismatch → reuse error.

### Integration (`app.inject`, Phase 03 harness)

- Auth class: N+1st login in the window returns `429` with `retryAfterSec` and `Retry-After`.
- Health is not rate-limited.
- Two creates with the same key, same body → one resource, identical status/body.
- Same key, different body → `409 IDEMPOTENCY_KEY_REUSE`.
- Missing key on a required route → `400`.
- Cross-tenant: org B cannot replay org A's key.
- Concurrent duplicate keys produce one user/project (use two overlapping injects).

### Unhappy paths

- Expired record does not replay and allows a new create.
- Stored body larger than cap is rejected at write, not silently truncated into a lying replay.

## 10. Definition of Done

- [ ] `@fastify/rate-limit` installed at latest stable after pre-install checks.
- [ ] Every non-probe route declares `rateLimitClass`; tests fail if one is missing.
- [ ] `429 RATE_LIMITED` matches Phase 02 envelope + `retryAfterSec`.
- [ ] `Idempotency-Key` on the mutating/async starts listed in §4.2.
- [ ] No second resource from a retried key, proven by integration test.
- [ ] No new `.env` keys. Budgets are constants.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/data-model.md`: `idempotencyRecords`.
- `docs/architecture.md` §10: rate-limit classes and idempotency header.
- `backend/solution.md` §13.1: replace "tunable via env" with "named constants (D13)".
- No new stack ADR (Phase 04 already records Fastify; library choice is local).

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Is `Idempotency-Key` required or optional** on the listed routes? Proposed: required.
2. **TTL index vs soft-delete sweeper** for expired records. Proposed: TTL index, because
   these are not user-facing domain entities.
3. **Retro-fit Phase 11 in this PR or a follow-up?** Proposed: this phase wires 07/08/11
   creates so the middleware is proven on a real route.
4. **In-process rate-limit store vs Mongo.** `@fastify/rate-limit` default is memory, which
   does not share across API processes. Acceptable for local/dev (D11, no fleet)? Proposed:
   memory now; document the escape hatch (shared store) in the ADR/escape hatch, do not add
   Redis.
5. **Auth IP ceiling of 20.** Confirm or pick another constant.
