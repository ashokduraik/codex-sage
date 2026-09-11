# Phase 12 — Idempotency (no in-app rate limiting)

- **Layer:** BE
- **Depends on:** Phase 09 (authenticated principal for key scope), Phase 02 (error catalog),
  Phase 03 (base schema, test harness)
- **Unblocks:** Phase 17 (create `Idempotency-Key`), Phase 22 (retry), Phase 23–24 (upload),
  Phase 30 (probe), later mutating/async starts
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §92; `backend/solution.md` §13;
  `docs/architecture.md` §2, §10; plan decision D13

## 1. Goal

After this phase mutating/async starts that opt in honour an `Idempotency-Key` header against
an `idempotencyRecords` collection in **shared MongoDB**, so a retried click does not create
a second user, project, upload, or job — even when the API runs as **PM2 cluster workers on
multiple hosts**.

You can see it working by sending the same `Idempotency-Key` on two `POST /users` creates and
getting the same stored `201` body the second time, with only one user row.

**Rate limiting is not implemented in the Node API.** Requirements §91 may still be satisfied
at the load balancer / edge if operators add limits there. In-process counters cannot be
correct across PM2 workers and multiple servers; Redis is out of scope (ADR 0004).

## 2. Why this phase is here

Upload, job retry, and admin creates cannot be safe against double-submit until the
idempotency middleware exists. It follows Phase 09 so keys are scoped by
`{ orgId, userId, route, key }`. It follows Phase 03 so `IdempotencyRecord` uses the base
schema and the test harness.

Phase 11's user create is already in the tree; this phase wires `POST /users` so the
middleware is proven on a real route before Phase 17.

## 3. Scope

### In scope

- `IdempotencyRecord` collection and middleware for mutating/async starts that set
  `config.requireIdempotencyKey: true`.
- Concurrent duplicate keys: first writer wins; the second waits or receives the stored
  response (no second resource).
- Retro-fit of `POST /users` (and strip unused `rateLimitClass` placeholders from auth routes).
- Docs: API deploy topology = PM2 cluster × multiple servers; shared Mongo for idempotency.

### Out of scope (owner phase)

- **In-app rate limiting** (`@fastify/rate-limit`, per-route classes, `429` from the API) —
  not in this product slice; optional at LB/edge only.
- Per-organization override of budgets — N/A (no in-app limits).
- Account lockout after N failed logins — separate from this phase.
- Frontend retry UX — Phase 13+.
- Idempotency on safe GETs.
- Wiring keys on routes that do not exist yet (project create / upload / retry — later phases).

## 4. Design

### 4.1 Running environment

```text
LB / edge (optional external rate limits)
        │
        ▼
API hosts × N  — each: PM2 cluster (multiple Node workers)
        │
        ▼
Shared MongoDB replica set  — domain data + idempotencyRecords
```

Idempotency state lives in Mongo so every worker and host sees the same keys.

### 4.2 Idempotency middleware

Clients send `Idempotency-Key` (header name exact) on:

| Operation | Owner phase | Behaviour |
|---|---|---|
| Admin user create | 11 / this phase | replay `201` body; one user |
| Project create | 17 | replay `201`; one project |
| Upload / sourceVersion | 24 | replay `202 { sourceVersionId, jobId }` |
| Job retry / reingest / repo sync | 22, 29, 32 | existing active job |
| Chat message create | 41 | existing message id |

Key uniqueness: `{ orgId, userId, route, key }` while `status: 'A'` and
`expiresAt > now`. Store `responseStatus`, `responseBody`, `resourceId` for replay
(capped size constant). TTL `IDEMPOTENCY_RECORD_TTL_MS` = 24h; Mongo TTL index on
`expiresAt` (these rows are not user-facing resources).

**Required** on routes with `requireIdempotencyKey: true`: missing header →
`400 IDEMPOTENCY_KEY_REQUIRED`.

Concurrent duplicates: insert the record in `processing` state first; the loser waits up
to `IDEMPOTENCY_WAIT_MS` then reads the winner's stored response, or
`409 IDEMPOTENCY_IN_FLIGHT` if still processing.

Mismatched payload for an existing key → `409 IDEMPOTENCY_KEY_REUSE`.

Handlers still own `reply`. Middleware throws `ApiError` or `IdempotencyReplay`; it does
not call `reply.send` for success paths (`function-design.mdc`).

### 4.3 Error codes

This phase registers: `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_REUSE`,
`IDEMPOTENCY_IN_FLIGHT`. Catalog may keep `RATE_LIMITED` for clients that see edge `429`s;
the API does not emit it from an in-app limiter.

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
`{ expiresAt: 1 }` TTL. Declared on the schema; synced via Phase 03 `syncSchemaIndexes`.

## 6. API contract

No new resource paths. Cross-cutting:

- Header `Idempotency-Key`: 8–128 chars `[A-Za-z0-9._-]`.
- Opt-in routes require the header.

## 7. Configuration & environment variables

**None.** Key length, TTL, and wait are constants (D13).

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `IDEMPOTENCY_KEY_MAX_LENGTH` | `128` | `platform/idempotency/idempotency.constants.js` | Header cap |
| `IDEMPOTENCY_KEY_MIN_LENGTH` | `8` | same | Header floor |
| `IDEMPOTENCY_RECORD_TTL_MS` | `86400000` | same | 24h |
| `IDEMPOTENCY_WAIT_MS` | `5000` | same | Wait for in-flight twin |
| `IDEMPOTENCY_BODY_MAX_BYTES` | `65536` | same | Stored replay cap |
| `IDEMPOTENCY_POLL_INTERVAL_MS` | `100` | same | Poll while waiting |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/platform/idempotency/*` | Constants, model, repository, middleware, tests |
| `backend/src/http/app.js` | Register idempotency hooks; CORS allow `Idempotency-Key` |
| `backend/src/platform/errorCatalog.js` | Idempotency codes |
| `backend/src/index.js` | Sync idempotency model indexes |
| Identity / auth routes | `requireIdempotencyKey` on `POST /users`; remove dead `rateLimitClass` |

## 9. Tests (≥ 80% line and branch)

### Unit

- Idempotency key validation (too short, illegal chars).
- Request hash mismatch → reuse error.

### Integration (`app.inject`)

- Two creates with the same key, same body → one resource, identical status/body.
- Same key, different body → `409 IDEMPOTENCY_KEY_REUSE`.
- Missing key on a required route → `400`.
- Concurrent duplicate keys produce one user.

## 10. Definition of Done

- [ ] `Idempotency-Key` on `POST /users` (and documented for later mutating starts).
- [ ] No second resource from a retried key, proven by integration test.
- [ ] No `@fastify/rate-limit`; no in-app rate-limit classes.
- [ ] Docs state PM2 multi-server + Mongo idempotency; rate limits external only.
- [ ] No new `.env` keys.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch for touched code.

## 11. Documentation & ADR updates

- `docs/data-model.md`: `idempotencyRecords`.
- `docs/architecture.md` §2 (PM2 multi-host) and §10 (idempotency; rate limit out of app).
- `backend/solution.md` §13: rate limiting not in API; idempotency in Mongo.
- ADR 0002: drop “rate-limit may attach later”.

## 12. Risks & open questions

Resolved for this slice:

1. **`Idempotency-Key` required** on opted-in routes.
2. **TTL index** for expired records.
3. **`POST /users` wired in this phase.**
4. **No in-app rate-limit store** — not applicable; limits (if any) are outside Node.
