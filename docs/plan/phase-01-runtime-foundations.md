# Phase 01 — Runtime, configuration & MongoDB connection

- **Layer:** BE
- **Depends on:** —
- **Unblocks:** Phase 02, 03, 20, 21 (everything that needs a datastore or a worker process)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §104 (observability), §137 (system
  configuration), §138 (scalability), §152 (authoritative backend state);
  `backend/solution.md` §2 (technologies), §3 (architecture);
  `docs/architecture.md` §2 (runtime processes), §3 (what lives where)

## 1. Goal

After this phase the backend has a **single validated configuration source**, a **live
connection to the external MongoDB 8 replica set**, a **versioned API namespace (`/api/v1`)**,
a **readiness endpoint that reports real dependency health**, **graceful shutdown**, and a
**second process entrypoint for the worker** that boots the same platform layer and then idles.

You can see it working by starting `npm run dev` and `npm run dev:worker` in `backend/`:
both log a successful Mongo connection, `GET /api/v1/health` returns `200`, and
`GET /api/v1/readiness` returns `503` when Mongo is stopped and `200` when it is running.
`SIGTERM` closes the HTTP server and the Mongo connection before the process exits.

## 2. Why this phase is here

Nothing else can be built first. Every later phase writes to MongoDB, and the worker process
(Phase 21) must exist as a deployable entrypoint before jobs can be claimed. The current
`src/platform/config.ts` parses env vars by hand with no schema, which will not scale to the
~40 variables this plan adds; replacing it now avoids rewriting every consumer later.

API versioning has to land before the first real route: `docs/architecture.md` §2 and
`solution.md` §2 both specify `/api/v1`, while the scaffold currently mounts routes at `/api`.
Changing it now costs one line; changing it after 60 routes exist does not.

## 3. Scope

### In scope

- Schema-validated configuration module covering server, logging, and MongoDB settings.
- Fail-fast startup: an invalid or missing required variable stops the process with a readable
  message listing every offending variable (not just the first).
- Mongoose connection module: connect, disconnect, connection-state reporting, connection event
  logging, and pool configuration.
- Route prefix moved from `/api` to `/api/v1`.
- Liveness (`/api/v1/health`) and readiness (`/api/v1/readiness`) endpoints.
- Graceful shutdown on `SIGTERM` / `SIGINT`: stop accepting requests, drain, close Mongo, exit.
- Worker entrypoint (`src/worker/index.ts`) that loads config, connects to Mongo, registers
  process safety nets, logs a heartbeat, and shuts down gracefully. It does **no** job work yet.
- `backend/.env.example` updated and mirrored into `backend/.env`.

### Out of scope (owner phase)

- Error-code catalog, correlation IDs, log redaction — **Phase 02**.
- Base Mongoose schema conventions, migrations, and the integration-test database harness —
  **Phase 03**.
- Job claiming, heartbeating, lease sweeping, scheduling — **Phase 21**.
- Any domain collection or route — **Phase 06 onward**.
- Authentication, rate limiting, CORS policy for production — **Phases 07, 12, 61**.
- Dockerfiles, deployment, provisioning the MongoDB cluster (decision D5: the cluster is
  supplied externally via connection string).

## 4. Design

### 4.1 Configuration module

Replace the hand-rolled parsing in `src/platform/config.ts` with a **schema-validated** loader.
Keep the existing exported shape where it is still correct so current consumers
(`http/app.ts`, `platform/logger.ts`, `src/test/appConfig.ts`) keep compiling.

Structure the resolved config into named groups so later phases extend one group instead of a
flat 40-field object:

```text
AppConfig
├── env        : { nodeEnv, isProduction, isTest, appRunningPlatform }
├── server     : { host, port, apiBasePath }
├── logging    : { level, logger, noConsoleLog }
└── mongo      : { uri, maxPoolSize, minPoolSize, serverSelectionTimeoutMs, socketTimeoutMs }
```

Rules the loader must follow:

- **One place only.** No `process.env` read may exist outside this module
  (`.cursor/rules/backend-api-standards.mdc`). Add an ESLint restriction if it is cheap;
  otherwise rely on review.
- **Validation collects all errors.** Throw a single `Error` whose message lists every invalid
  variable, one per line, with the expected format. Do not print the offending *values* — a
  connection string contains credentials (backend §148).
- **`MONGODB_URI` is required and has no default.** A wrong default silently pointing at
  `localhost` would let tests and dev runs pass against the wrong database.
- **Behaviour is driven by config, not by scattered `NODE_ENV` checks**
  (`.cursor/rules/environment-standards.mdc`). Derive `isProduction` / `isTest` once here.

Validation library: **zod** is named in `solution.md` §2 ("Packages (indicative)"). Before
installing, run the pre-install checks required by `.cursor/rules/dependency-versions.mdc`
(`npm view zod version`, `npm view zod time`, `npm view zod deprecated`, repository activity)
and install the latest stable. Do the same for `mongoose`.

### 4.2 Mongo connection module

New file `src/platform/mongo.ts`, the only module that talks to Mongoose's connection API.

```text
connectMongo(config)      → opens the connection, awaits the first successful connect,
                            logs { host-less summary, replicaSet, poolSize }
disconnectMongo()         → closes the connection (idempotent; safe to call twice)
getMongoConnectionState() → 'disconnected' | 'connected' | 'connecting' | 'disconnecting'
checkMongoHealth()        → runs an admin `ping`, returns { ok, latencyMs, error? }
```

Behaviour requirements:

- **Fail fast at startup, resilient afterwards.** If the first connect fails, the process logs
  the error and exits non-zero — a process that cannot reach its datastore must not report
  itself healthy. After a successful first connect, Mongoose's own reconnection handles
  transient drops; log `disconnected` / `reconnected` transitions at `warn` / `info`.
- **Never log the connection string.** It carries credentials. Log a redacted descriptor
  (database name and replica-set name only). Phase 02 formalises redaction.
- `bufferCommands` should be disabled so a query issued while disconnected fails loudly instead
  of hanging until an opaque timeout.
- Transactions are available (decision D5, replica set). This phase does not use them; it only
  must not configure anything that prevents them.
- `autoIndex` is enabled in development and disabled in production; index creation belongs to
  the migration path in Phase 03.

### 4.3 API versioning, health and readiness

`http/app.ts` currently registers routes with `{ prefix: '/api' }`. Change it to
`config.server.apiBasePath` (default `/api/v1`), so the value is configurable but never guessed
at a call site.

Two distinct endpoints, because they answer two different questions:

| Endpoint | Question | Depends on Mongo? |
|---|---|---|
| `GET /api/v1/health` | Is this process alive and serving? | No |
| `GET /api/v1/readiness` | Can it serve real traffic right now? | Yes |

Readiness runs `checkMongoHealth()` and returns `503` when the check fails. It must **not**
fabricate a healthy answer while the datastore is unreachable — backend §152 makes the backend
the authority on state, and §98 of the frontend requirements forbids showing states the product
cannot back up.

Both endpoints stay unauthenticated (they are infrastructure probes) and must expose nothing
sensitive: no connection string, no host names, no stack traces.

### 4.4 Graceful shutdown

New file `src/platform/shutdown.ts` with a small ordered-hook registry:

```text
registerShutdownHook(name, fn)   → later phases add: worker loop stop, SSE drain, queue drain
runShutdown(signal)              → runs hooks in reverse registration order, each with a
                                   timeout; logs per-hook outcome; exits 0 on success, 1 if a
                                   hook threw or timed out
```

Wired to `SIGTERM` and `SIGINT` in both entrypoints. Phase 01 registers two hooks: close the
Fastify server, then `disconnectMongo()`. A second signal while shutdown is in progress forces
an immediate exit.

`src/platform/processHandlers.ts` already registers the `unhandledRejection` (log, stay alive)
and `uncaughtException` (log, exit 1) safety nets required by
`.cursor/rules/error-handling.mdc`. Keep that behaviour; only make the worker entrypoint use it
too.

### 4.5 Worker entrypoint

`docs/architecture.md` §2 requires the worker to be a **separate process with its own PID and
event loop**, deployable independently, communicating with the API only through MongoDB. Create
`src/worker/index.ts` now so that contract is real from the start:

```text
1. registerProcessHandlers()
2. loadConfig()
3. connectMongo()
4. log 'worker started' with a worker id (hostname + pid)
5. idle interval that logs a debug heartbeat            ← Phase 21 replaces this with the claim loop
6. SIGTERM/SIGINT → runShutdown()
```

Add `dev:worker` (tsx watch) and `start:worker` (node dist) scripts, and a second `tsup` entry
so `npm run build` emits both `dist/index.js` and `dist/worker/index.js`.

## 5. Data model changes

**None.** No collection is created in this phase. The `status: 'A' | 'D'` convention and the
base schema helper arrive in Phase 03.

## 6. API contract — PROPOSED (needs approval before implementation)

> The existing `GET /api/health` moves to `GET /api/v1/health`. No client consumes it yet
> (the frontend has no HTTP client until Phase 13), so this is a safe rename.

### `GET /api/v1/health`

- **Auth:** none.
- **Response `200`:**

```json
{
  "status": "ok",
  "uptimeSeconds": 128,
  "version": "0.0.0"
}
```

### `GET /api/v1/readiness`

- **Auth:** none.
- **Response `200` (ready) / `503` (not ready)** — same body shape, `status` differs:

```json
{
  "status": "ready",
  "checks": {
    "mongo": { "status": "up", "latencyMs": 3 }
  }
}
```

Not-ready example:

```json
{
  "status": "not_ready",
  "checks": {
    "mongo": { "status": "down", "error": { "code": "MONGO_UNAVAILABLE" } }
  }
}
```

- `checks.mongo.error` carries a **code only** — never the driver message, which can contain
  host and credential fragments.
- Errors elsewhere in the service continue to use the existing envelope
  `{ error: { code, message, details? } }` from `src/platform/errors.ts`.

## 7. Configuration & environment variables

Add to `backend/.env.example` **and** mirror the same keys into `backend/.env`
(`.cursor/rules/env-example-sync.mdc`). Never print `.env` contents in chat or logs.

| Variable | Example | Required | Purpose |
|---|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/codex_sage?replicaSet=rs0` | **yes** | Replica-set connection string, database name included |
| `MONGODB_MAX_POOL_SIZE` | `20` | no (default `20`) | Upper bound of the connection pool |
| `MONGODB_MIN_POOL_SIZE` | `0` | no (default `0`) | Lower bound of the connection pool |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | `10000` | no (default `10000`) | How long to wait for a reachable primary before failing |
| `MONGODB_SOCKET_TIMEOUT_MS` | `45000` | no (default `45000`) | Socket inactivity timeout |
| `API_BASE_PATH` | `/api/v1` | no (default `/api/v1`) | Versioned route prefix |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | no (default `10000`) | Per-hook shutdown budget before a forced exit |

Existing variables (`API_HOST`, `API_PORT`, `NODE_ENV`, `APP_RUNNING_PLATFORM`, `LOG_LEVEL`,
`NO_CONSOLE_LOG`) stay, now validated by the schema.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/package.json` | Add `mongoose`, `zod`; add `dev:worker` / `start:worker` scripts |
| `backend/tsup.config.ts` | Second entry for the worker build |
| `backend/src/platform/config.ts` | **Rewrite:** schema validation, grouped config, all-errors reporting |
| `backend/src/platform/config.test.ts` | **Extend:** valid/invalid matrices, missing `MONGODB_URI`, defaults |
| `backend/src/platform/mongo.ts` | **New:** connect / disconnect / state / health |
| `backend/src/platform/mongo.test.ts` | **New:** connection lifecycle and health behaviour |
| `backend/src/platform/shutdown.ts` | **New:** ordered shutdown hook registry |
| `backend/src/platform/shutdown.test.ts` | **New:** ordering, timeout, double-signal handling |
| `backend/src/http/app.ts` | Mount routes at `config.server.apiBasePath` |
| `backend/src/http/app.test.ts` | **Update:** assert the `/api/v1` prefix |
| `backend/src/modules/health/health.routes.ts` | Add readiness; keep liveness free of dependencies |
| `backend/src/modules/health/health.routes.test.ts` | **Extend:** ready and not-ready paths |
| `backend/src/index.ts` | Connect Mongo before listening; register shutdown hooks |
| `backend/src/worker/index.ts` | **New:** worker process entrypoint |
| `backend/src/worker/index.test.ts` | **New:** boot sequence and shutdown |
| `backend/src/test/appConfig.ts` | **Extend:** test config fixture with the `mongo` group |
| `backend/.env.example` | Document the new variables |
| `backend/.env` | Mirror the new keys (no real secrets committed) |

## 9. Tests (≥ 80% line and branch)

### Unit

- `loadConfig` returns defaults when optional variables are absent.
- `loadConfig` throws when `MONGODB_URI` is missing, and the message names the variable.
- `loadConfig` throws listing **all** invalid variables when several are wrong at once.
- `loadConfig` rejects a non-numeric / out-of-range `API_PORT` and a non-positive pool size.
- The thrown message does **not** contain the value of `MONGODB_URI`.
- `parseLogLevel` / `parseAppRunningPlatform` keep their existing fallback behaviour.
- `shutdown` runs hooks in reverse registration order.
- `shutdown` reports a failing hook and still runs the remaining hooks, exiting non-zero.
- `shutdown` enforces `SHUTDOWN_TIMEOUT_MS` per hook.
- A second signal during shutdown forces an immediate exit.
- `checkMongoHealth` returns `{ ok: false, error }` when the ping rejects — and the returned
  error carries a code, not the driver string.
- `getMongoConnectionState` maps every Mongoose readyState value.

### Integration (Fastify `app.inject`, Mongo mocked at the module boundary)

- `GET /api/v1/health` returns `200` with `status: 'ok'`.
- `GET /api/health` (unversioned) returns `404` — the prefix really moved.
- `GET /api/v1/readiness` returns `200` and `checks.mongo.status === 'up'` when healthy.
- `GET /api/v1/readiness` returns `503` and `status: 'not_ready'` when the ping fails.
- Readiness responses contain no connection string, host, or stack trace.
- `buildApp` still decorates `app.config`.

### Unhappy paths that must be covered

- First connect fails → startup logs the failure and exits non-zero (assert on the injected
  exit/log seams, not by killing the test runner).
- Mongo drops after a successful start → a `warn` is logged and readiness flips to `503`.
- `disconnectMongo()` called twice does not throw.

## 10. Definition of Done

- [ ] `MONGODB_URI` and the other new variables exist in `backend/.env.example` and are
      mirrored in `backend/.env`.
- [ ] No `process.env` access exists anywhere outside `src/platform/config.ts`.
- [ ] Startup with an invalid configuration exits with a message listing every offending
      variable and no secret values.
- [ ] `npm run dev` connects to the external replica set and logs a redacted summary.
- [ ] `npm run dev:worker` starts a second process that connects to Mongo and idles.
- [ ] All routes are served under `/api/v1`; the old `/api` prefix returns `404`.
- [ ] `GET /api/v1/readiness` returns `503` while Mongo is unreachable and `200` when it is not.
- [ ] `SIGTERM` closes the HTTP server and the Mongo connection, then exits `0`.
- [ ] `npm run typecheck`, `npm run lint`, and `npm test` pass in `backend/`.
- [ ] Coverage for every file this phase touched is ≥ 80% line and ≥ 80% branch.
- [ ] `mongoose` and `zod` were installed at latest stable after the
      `dependency-versions.mdc` pre-install checks, and both the manifest and lockfile are
      committed.
- [ ] No secret, connection string, or credential appears in any log line or HTTP response.

## 11. Documentation & ADR updates

- `docs/architecture.md`: confirm §2's "API process / Worker process" description matches the
  entrypoints that now exist (`src/index.ts`, `src/worker/index.ts`); adjust wording if the
  paths differ.
- ADRs for MongoDB, Mongoose, and Fastify are written in **Phase 04**, not here. If an ADR is
  needed sooner because a reviewer challenges a choice, write it in `docs/adr/` rather than
  arguing in the pull request.
- Update `backend/solution.md` only if this phase contradicts it — it should not.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Database name:** should it live inside `MONGODB_URI` (as proposed) or be a separate
   `MONGODB_DB_NAME` variable so one cluster can host `dev` / `test` databases?
2. **Test database:** do integration tests in later phases run against the same external
   replica set (a separate database name), or against `mongodb-memory-server` as
   `solution.md` §2 suggests? `mongodb-memory-server` needs replica-set mode for transactions.
   Phase 03 owns the harness, but the answer affects what this phase documents.
3. **Health endpoint aliases:** keep an unversioned `/health` for infrastructure probes, or is
   `/api/v1/health` the only probe path?
4. **Version string** in the health response: read from `backend/package.json`, from a build-time
   env var, or omit it entirely?
5. **TLS / auth options:** does the supplied replica set require a CA file, client certificate,
   or `authSource`? If so, those become additional validated variables here.
6. **Readiness semantics:** should readiness also fail when the CodeGraph workspace volume is
   unavailable (later phases), or stay Mongo-only? Proposal: extend the `checks` map per phase,
   keeping one readiness contract.
