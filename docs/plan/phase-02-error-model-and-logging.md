# Phase 02 — Error model, correlation IDs & safe logging

- **Layer:** BE
- **Depends on:** Phase 01
- **Unblocks:** every later backend phase (all of them raise errors and log)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §39 (error model), §104 (observability),
  §105 (error correlation), §109 (retry strategy), §110, §148 (secret protection), §149
  (logging), §151; `backend/solution.md` §4.6 hard rule 3, §5.6, §5.8; `docs/architecture.md`
  §9 (SSE events), §10 (cross-cutting)

## 1. Goal

After this phase every backend failure has a **class**, a **stable code**, a **retryability
verdict**, and a **reference identifier** that appears in the response body, in a response
header, and in every log line for that request. One catalog module is the only place an error
code may be defined; Pino redacts secrets, and no source body, chat content, or personal data
reaches a log. Call an unknown route to see it: the body carries `code: NOT_FOUND`,
`class: user`, `retryability: permanent` and `reference: REQ-…`, the same `REQ-…` is in the
`X-Correlation-Id` header, and the log line has `reqId` and no authorization header value.

## 2. Why this phase is here

Error codes and correlation ids are cross-cutting. The moment phase 06 adds the first domain
module every service starts inventing its own error strings, and retrofitting a taxonomy across
40 modules costs far more than defining it once. It follows phase 01 because the catalog and the
logger read that phase's validated configuration and because phase 01 already produced the first
two codes this catalog must adopt. It does not block phase 03, which only consumes
`TENANT_SCOPE_MISSING` and `INVALID_CURSOR` from here — the two can run in parallel.

## 3. Scope

### In scope

- The error **class** taxonomy of backend §39, minus the query classes.
- One error-code catalog: code → class, HTTP status, retryability, default message.
- Retryability classification (`temporary` / `permanent` / `user_action_required`) and a pure
  backoff calculator that phases 21 and 45 call.
- Correlation identifier generation, its relation to Fastify's `request.id`, and propagation into
  responses, headers, logs and error bodies, including an `AsyncLocalStorage` context so services
  read it without threading it through every signature.
- Extension of `src/platform/errors.js` and `src/platform/logger.js` (redaction, serializers,
  environment-driven verbosity), plus a pure builder for the SSE terminal `error` frame.

### Out of scope (owner phase)

- Query-class errors — the customer-database path is out of scope for the plan (README §5).
- Audit records carrying the correlation id — **Phase 10**; job correlation ids, retry scheduling
  and backoff persistence — **Phases 20–22**; the SSE endpoint that emits the terminal frame —
  **Phase 50**; `429` behaviour — **Phase 12** (only the code is registered here).
- Frontend rendering of `error.message` — **Phase 13**. Error tracking — **Phase 62**.

## 4. Design

### 4.1 Error classes

| Class | Meaning | Default HTTP | Default retryability |
|---|---|---|---|
| `user` | Bad input or malformed request | 400 / 404 / 409 / 422 | `user_action_required` |
| `authorization` | Not authenticated, or lacking the permission | 401 / 403 | `permanent` |
| `source` | Uploaded bytes unusable (bad archive, zip slip, empty after excludes) | 400 / 422 | `user_action_required` |
| `repository` | Remote unreachable, credentials rejected, branch missing | 400 / 424 | set per code |
| `processing` | An ingest stage failed | 500 / 503 | set per code |
| `knowledge` | Graph updating, unavailable, or failed | 409 / 503 | `temporary` |
| `system` | Defect or unexpected internal state | 500 | `permanent` |
| `temporary` | A dependency is momentarily unavailable | 503 | `temporary` |

`temporary` is deliberately both a class and a retryability value: the class says what broke, the
retryability says what the caller should do, and a `processing` error may still be retryable.
Separating them makes solution §4.6 hard rule 3 mechanically enforceable.

### 4.2 The error-code catalog

New file `src/platform/errorCatalog.js`, a frozen record and the **only** place a code may be
introduced:

```text
ERROR_CATALOG: Record<ErrorCode, {
  class: ErrorClass; httpStatus: number;
  retryability: 'temporary' | 'permanent' | 'user_action_required';
  message: string;   // stable, non-sensitive, English default
}>
```

Codes are `SCREAMING_SNAKE_CASE` and never renamed, because phase 13 maps them to i18n keys. Each
phase adds its own codes here and nothing else defines codes. A code that reaches the global
handler but is missing from the catalog is served as `INTERNAL_ERROR` and logged at `error` level
as a defect. A `message` never contains a value, path, host, or anything derived from a secret
(§148). Seeded now: `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHENTICATED`, `FORBIDDEN`, `CONFLICT`,
`RATE_LIMITED`, `IDEMPOTENCY_CONFLICT`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`,
`MONGO_UNAVAILABLE`, `TENANT_SCOPE_MISSING`, `INVALID_CURSOR`, `KNOWLEDGE_UNAVAILABLE`,
`CONTEXT_ACCOUNTING_UNAVAILABLE` — the last two are named verbatim in solution §1.2 and §5.8, so
registering them now stops later phases spelling them differently.

### 4.3 Retryability and backoff

New file `src/platform/retryPolicy.js`, pure functions only: `classifyRetryability(code)` returns
the catalog verdict, `isAutoRetryable(code)` is true only for `temporary`, and
`computeRetryDelayMs(attempt, policy)` is capped exponential backoff with full jitter, its policy
values taken from named constants in that file rather than env vars. Backend §109 and solution
§4.6 hard rule 3 reduce to two testable invariants: only `temporary` codes are auto-retried, and
`permanent` / `user_action_required` codes never increment an attempt counter. Phase 21 owns the
worker loop and phase 45 the Ollama retry path; neither re-implements the classification.

### 4.4 Correlation identifiers and `request.id`

**Decision: the correlation id *is* Fastify's `request.id`** — no second identifier and no mapping
table. `buildApp()` supplies a `genReqId` returning `REQ-` plus `node:crypto.randomUUID()` with
dashes stripped, so the `reqId` Fastify already binds to every log line is exactly the reference
support receives (backend §105 shows `Reference: REQ-…`). No new dependency is needed.

| Destination | How |
|---|---|
| Logs | Fastify's per-request child logger already binds `reqId` |
| Response header | `onSend` hook sets `X-Correlation-Id` on **every** response |
| Error body | The global handler copies it into `error.reference` |
| SSE terminal frame | The stream error builder embeds it (§4.5) |
| Services / repositories | `src/platform/requestContext.js`, an `AsyncLocalStorage` store of `{ correlationId, orgId?, userId? }` entered by an `onRequest` hook |

The tenant fields are declared now and populated in phase 07 so the log shape does not change
later. Reads outside a request return `undefined` rather than throwing, so worker code keeps
working; phase 21 enters the same store with a job-derived id. Client-supplied correlation ids are
**not** honoured — an attacker-controlled reference poisons support lookups and injects content
into logs (§12 question 1).

### 4.5 Failures after the response has started

Once stream headers are sent the HTTP status cannot carry the failure, so a terminal chunk must be
emitted (`.cursor/rules/error-handling.mdc`). `errors.ts` already exposes `canSendJsonError`; this
phase adds `src/platform/streamErrors.js` with a pure builder
`buildStreamErrorEvent(error, correlationId)` returning
`{ event: 'error', data: { code, class, retryability, message, reference } }`. The builder never
touches the reply: per `.cursor/rules/function-design.mdc` the handler owning the stream (phase
50) writes the frame and ends it. The global handler cannot do that on the handler's behalf
because it does not know the stream's framing state; when `canSendJsonError` is false it logs at
`error` with `reqId` and returns, and that log line is the signal that a stream owner failed to
emit its terminal frame. An empty catch that only ends the stream is forbidden.

### 4.6 Redaction, verbosity, and what must never be logged

`logger.ts` gains a Pino `redact` config — a plain option, so it also applies when the transport
runs in a worker thread, unlike custom formatters:

```text
paths: req.headers.authorization, req.headers.cookie, req.headers['set-cookie'],
       req.headers['x-api-key'], *.password, *.passwordHash, *.token, *.accessToken,
       *.refreshToken, *.credentials, *.secret, *.mongodbUri, *.connectionString, *.privateKey
censor: '[redacted]'
```

Path redaction is a safety net, not the policy. The policy is **deny by default**: bodies are
never logged; the `req` serializer emits `method`, route path, `reqId` and `remoteAddress` only,
dropping the query string because it can carry a search term; source bytes, document text, chat
content and answer text are never log fields, so log ids, counts, byte sizes and error codes
instead (backend §149, solution §9.1); personal data is logged as `userId`, never an email or a
name; `err.details` is dropped unless the catalog marks that code's details non-sensitive.
Verbosity comes from validated config, not scattered `NODE_ENV` checks
(`.cursor/rules/environment-standards.mdc`): development logs at `debug` with stacks always,
production at `info` and above with stacks only at `error`. The client-facing body is identical in
both environments and 5xx always returns the stable message `Internal server error`.

## 5. Data model changes

**None.** No collection or field is added. The audit record that carries `correlationId` is
defined in phase 10.

## 6. API contract — PROPOSED (needs approval before implementation)

The envelope `{ error: { code, message, details? } }` is **extended**, not replaced.

```json
{
  "error": {
    "code": "KNOWLEDGE_UNAVAILABLE", "class": "knowledge", "retryability": "temporary",
    "message": "Project knowledge is being updated.",
    "reference": "REQ-8f1c2d0a4b7e4a9f9c1e5d3b7a0c6e21",
    "details": { "retryAfterSec": 30 }
  }
}
```

`class` is one of the eight values in §4.1 and `retryability` one of the three verdicts.
`reference` equals the `X-Correlation-Id` header, set on **every** response including successes.
`details` is omitted unless the catalog declares a non-sensitive detail shape for that code. The
SSE terminal frame (shape only; emitted from phase 50) is the `error` event of architecture §9
carrying those same five fields as its `data` object. Phase 01's readiness body nests
`checks.mongo.error.code`; that is a health-check field, not the error envelope, and stays a bare
`{ code }` object.

## 7. Configuration & environment variables

**None.** `LOG_LEVEL` already exists from phase 01 and now also controls stack-trace verbosity.
Do not add correlation-id or retry knobs to `.env`.

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `CORRELATION_ID_PREFIX` | `'REQ'` | `platform/requestContext.js` | Prefix of the generated reference |
| `CORRELATION_ID_HEADER` | `'X-Correlation-Id'` | `http/app.ts` | Response header name |
| `RETRY_BASE_DELAY_MS` | `1000` | `platform/retryPolicy.js` | First backoff step for `temporary` failures |
| `RETRY_MAX_DELAY_MS` | `60000` | `platform/retryPolicy.js` | Backoff cap |
| `RETRY_MAX_ATTEMPTS` | `5` | `platform/retryPolicy.js` | Attempt ceiling for auto-retry |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/platform/errorCatalog.js` + `.test.js` | **New:** the single code → class/status/retryability/message table |
| `backend/src/platform/errors.js` + `.test.js` | **Extend:** new envelope fields, catalog-driven mapping, unknown-code defect log |
| `backend/src/platform/retryPolicy.js` + `.test.js` | **New:** classification helpers and jittered backoff (constants in this file) |
| `backend/src/platform/requestContext.js` + `.test.js` | **New:** `AsyncLocalStorage` correlation/tenant context |
| `backend/src/platform/streamErrors.js` + `.test.js` | **New:** pure SSE terminal-frame builder |
| `backend/src/platform/logger.js` + `.test.js` | **Extend:** redact paths, `req`/`err` serializers, level-driven stacks |
| `backend/src/http/app.js` + `app.test.js` | `genReqId`, `onRequest` context hook, `onSend` header hook |
| `backend/src/test/appConfig.js` | Fixture stays as-is unless a real env field is added |

## 9. Tests (≥ 80% line and branch)

### Unit

- Every catalog entry has a class, a status in 400–599, a retryability and a non-empty message;
  no message contains a URI, a file path or the substring `password`; keys are unique.
- `classifyRetryability` returns the catalog verdict for a known code and `permanent` otherwise.
- `computeRetryDelayMs` grows exponentially, never exceeds `RETRY_MAX_DELAY_MS`, and stays inside
  the jitter window under a stubbed random source.
- The reference generator uses the configured prefix, has a stable length, and does not collide.
- `requestContext` keeps interleaved async flows separate; reads outside a request are `undefined`.
- `buildStreamErrorEvent` returns the `error` event with all five fields and drops
  non-allowlisted `details`; the `req` serializer omits query string, authorization header and
  cookies; a logged object with `password`, `token` and `connectionString` shows `[redacted]`.

### Integration (Fastify `app.inject`) and unhappy paths

- A thrown `ApiError` returns the full envelope with `reference` equal to the header value.
- `throw new Error('boom')` returns 500 `INTERNAL_ERROR` / `class: 'system'` with the stable
  message, the original text appearing only in the log.
- An unknown route returns `NOT_FOUND` with `class: 'user'`, a successful `GET /api/v1/health`
  still carries `X-Correlation-Id`, and two concurrent requests get different references.
- A client-supplied `X-Correlation-Id` is ignored and a fresh reference is generated.
- An error thrown after headers are sent writes no second response and logs at `error` with
  `reqId`; a code missing from the catalog is served as `INTERNAL_ERROR` and logged as a defect;
  a validation error returns field details without echoing the submitted value.

## 10. Definition of Done

- [ ] Every error code used in `backend/src` is defined in `errorCatalog.ts`, and
      `CONTEXT_ACCOUNTING_UNAVAILABLE` and `KNOWLEDGE_UNAVAILABLE` are registered as `temporary`.
- [ ] Every JSON error carries `code`, `class`, `retryability`, `message`, `reference`, and every
      response carries `X-Correlation-Id` equal to `request.id` and to that request's log `reqId`.
- [ ] Only `temporary` codes are auto-retryable; the backoff calculator is pure and uses the
      retry constants in `retryPolicy.ts`.
- [ ] No test log output contains an authorization header, cookie, password, token, connection
      string, request body, or query string.
- [ ] The SSE terminal-frame builder exists and writes nothing to a reply itself.
- [ ] No new `.env` keys. Correlation prefix, header name, and retry numbers are constants.
- [ ] `npm run lint` and `npm test` pass; touched files are ≥ 80% line and
      branch coverage.

## 11. Documentation & ADR updates

- Add an "Errors and correlation" subsection to `docs/architecture.md` §10 naming the catalog as
  the source of truth for codes.
- Phase 04 records the structured-error-envelope decision as an ADR; if phase 04 has not landed
  when this phase does, write that ADR here instead of leaving the decision undocumented.
  `backend/solution.md` needs no change — this phase implements §4.6 hard rule 3.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Client-supplied correlation ids.** The proposal ignores inbound `X-Correlation-Id`. Should a
   trusted upstream be allowed to supply one, and under what validation?
2. **Public error fields.** Should `class` and `retryability` be visible to the browser, or kept
   internal with the frontend branching on `code` alone? §39 requires structured errors but does
   not name the fields.
3. **Reference format.** `REQ-<32 hex>` adds no dependency; a ULID would be shorter and sortable
   but needs a package. Which does support tooling prefer?
4. **Message ownership.** The catalog carries an English default and phase 13 maps codes to i18n
   keys. If wording must live only in the frontend, the catalog message becomes a developer-facing
   string — decide before phase 13.
5. **`details` allowlist.** Which codes may return structured details, and may a detail ever
   contain a repository or file path? §148 argues for a conservative default.
6. **Worker correlation ids.** Should phase 21 reuse the `REQ-` prefix or use `JOB-` so support
   can tell the origin apart? Same question for one global `RETRY_MAX_ATTEMPTS` versus separate
   budgets for ingest stages and Ollama calls.
