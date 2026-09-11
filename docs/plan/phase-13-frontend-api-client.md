# Phase 13 — Frontend API client & server-state layer

- **Layer:** FE
- **Depends on:** Phase 07 (auth endpoints and the token/refresh contract)
- **Unblocks:** Phase 14, 15, 16, 19, 33, 34, 35, 36, 40, 54–57, 58, 59, 60 — every frontend
  slice that reads or writes backend state
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §64 (response errors), §90 (error states),
  §98 (technical realism), §105.38 (show rate limits and correlation IDs when the backend
  provides them); `backend/requirments.md` §105 (error correlation);
  `backend/solution.md` §8.3 (auth), §13 (rate limit / idempotency);
  `docs/architecture.md` §9 (React → Fastify connection)

## 1. Goal

After this phase the frontend has **one typed way to call the backend**. A single
`frontend/src/shared/api/` module owns the base URL, the access token, the
`{ error: { code, message, details? } }` envelope, the support correlation ID, a single-flight
refresh-on-401, and request cancellation. `shared/lib/query-client.js` gains real defaults so
every later slice inherits the same retry, staleness and error behaviour.

You can see it working through the test suite: with a mocked `fetch`, a `200` returns typed
data, a `400` throws an `ApiError` carrying `code`, `message` and `correlationId`, two
concurrent `401`s trigger exactly one refresh call and both original requests are retried once,
and a failed refresh clears the session exactly once. No feature is rewired in this phase.

## 2. Why this phase is here

Every frontend slice from Phase 14 onward needs the same four things: a base URL, an auth
header, a parsed error, and React Query defaults. Building them once here is the difference
between one implementation and fourteen. It sits after Phase 07 because the token shape, the
refresh endpoint and the 401 semantics are defined there — inventing them now would violate
`.cursor/rules/no-assumptions.mdc`. It sits before Phase 14 because the auth slice is a consumer
of this layer: the refresh loop lives in the client, and `AuthContext` only supplies and clears
the session.

## 3. Scope

### In scope

- `frontend/src/shared/api/` module: config, request function, `ApiError`, session holder,
  refresh coordinator, error-code to i18n-key mapping, public `index.js`.
- Validated `VITE_API_BASE_URL` read in exactly one place, with a readable startup failure when
  it is missing or malformed.
- Parsing of the backend error envelope, including HTTP failures with no parseable body.
- Capture of the support correlation / reference ID and exposure on `ApiError`.
- Access-token attachment plus single-flight refresh-on-401 that retries the original request
  once and otherwise clears the session and notifies subscribers.
- React Query defaults on the existing `queryClientInstance`.
- `AbortSignal` support so React Query's `signal` cancels in-flight requests.
- i18n additions under `errors.*` so every known backend code has a user-facing string and an
  unknown code falls back to a generic localized message.
- `frontend/.env.example` updated and mirrored into `frontend/.env`; `vite.config.js` test env
  pinned to the same value.

### Out of scope (owner phase)

- Any feature rewiring, hooks, or component changes — **Phases 14–16 and later slices**.
- Login / refresh / logout call sites and token persistence choice — **Phase 14**.
- SSE consumption for chat — **Phase 55** (this client is request/response only).
- File upload progress transport — **Phase 33**.
- `Idempotency-Key` generation for uploads, retries and admin creates — the header pass-through
  is built here, the per-action keys belong to **Phases 12, 33, 35**.

## 4. Design

### 4.1 Module layout

```text
shared/api/
├── apiConfig.ts     resolve + validate VITE_API_BASE_URL once
├── ApiError.ts      typed error: status, code, message, details, correlationId
├── apiSession.ts    in-memory access token + session-cleared subscribers
├── refreshClient.ts single-flight refresh coordinator
├── apiRequest.ts    the one fetch wrapper everything uses
├── errorMessages.ts backend error code → i18n key
└── index.ts         public surface (no deep imports from features)
```

`apiRequest` is the only place in `frontend/src/` that calls `fetch`. Features import hooks;
hooks import `shared/api`.

### 4.2 Base URL

`import.meta.env.VITE_API_BASE_URL` is read in `apiConfig.ts` and nowhere else. It must be a
non-empty string that is either a same-origin path starting with `/` or an absolute `http(s)`
URL; anything else throws at module load with a message naming the variable. Trailing slashes
are trimmed so call sites always write `apiRequest('/auth/login')`.

Phase 01 moves the backend to `/api/v1`, so the committed default changes from `/api` to
`/api/v1`. The Vite dev proxy already forwards `/api` and keeps working unchanged.

### 4.3 Errors

`ApiError extends Error` with `status`, `code`, `message`, `details?`, `correlationId?`.
Construction rules, in order:

1. Body parses as `{ error: { code, message, details? } }` → use those values verbatim. The
   backend message is the user-facing text (`ui-action-feedback.mdc`: never fabricate it).
2. Body is missing, empty, or not that shape → `code = 'UNEXPECTED'` and a **localized**
   fallback, never the raw transport string (`fetch failed`, `terminated`).
3. `fetch` itself rejects → `code = 'NETWORK'`, localized fallback, `status = 0`.
4. The request was aborted → a distinguishable abort path that callers must **not** render as
   a failure.

`correlationId` is required by frontend §90 and §105.38 and by backend §105. **Decision (Phase
02):** it is Fastify's `request.id`, returned as `X-Correlation-Id` on every response and as
`error.reference` on error bodies. The client reads `X-Correlation-Id` first, then
`error.reference`, and treats it as absent when neither exists rather than inventing one.

### 4.4 Code-to-message mapping

`errorMessages.ts` maps a backend `code` to an i18n key under `errors.codes.*`. The **backend
message is what is shown**; the mapping exists so the UI can localize known codes and classify
the failure into the categories frontend §64 and §90 require — authorization, validation,
temporary, rate limited, generic system failure — so slices can pick the right next action.
Unknown codes render the backend message as-is, or `errors.unexpected` when there is none.

### 4.5 Token attachment and single-flight refresh

`apiSession.ts` holds the access token in module memory (never in a React state tree, so a
render is not needed to read it) and exposes `setAccessToken`, `getAccessToken`,
`clearSession`, and a subscribe hook that Phase 14 uses to react to session loss.

On a `401` for any request other than the refresh call itself:

```text
1. If a refresh is already in flight, await that same promise (single flight).
2. Otherwise start one refresh call and store its promise.
3. Refresh succeeds → store the new token, retry the original request exactly once.
4. Refresh fails, or the retry also returns 401 → clearSession(), notify subscribers once,
   and throw the ApiError from the original request.
```

The retry counter is per-request, so a persistently failing endpoint cannot loop. Requests that
carry `skipAuthRefresh` (login, the refresh call) never enter this path. **Decision D14:**
refresh sends no body token; `credentials: 'include'` so the httpOnly cookie is attached, plus
the CSRF header from Phase 07. `refreshClient.ts` is the only function that performs that call.

### 4.6 React Query defaults

Replace the current two-line default block in `shared/lib/query-client.js`:

| Option | Value | Reason |
|---|---|---|
| `queries.retry` | custom: none on status `400`–`499`; up to 2 on network/`5xx` | Retrying an authorization or validation failure is noise |
| `queries.retryDelay` | exponential with a cap | Avoids hammering a degraded backend |
| `queries.staleTime` | 30 s default; slices override | Admin lists tolerate it; job status does not |
| `queries.gcTime` | 5 min | Keeps back-navigation instant |
| `queries.throwOnError` | `false` | Slices render inline `role="alert"`, not boundaries |
| `mutations.retry` | `0` | A retried create is a duplicate create |

`refetchOnWindowFocus: false` stays as it is today.

Query functions receive React Query's `signal` and pass it to `apiRequest`, so navigating away
aborts the request instead of resolving into a discarded cache entry.

## 5. Data model changes

**None.** This is a frontend-only phase; no collection, field or index is added or changed.

## 6. API contract — PROPOSED (needs approval before implementation)

This phase defines **no new endpoint**. It defines the frontend-visible contract details it
relies on. All of them must be confirmed against Phases 02 and 07 before implementation.

### Request headers sent by the client

| Header | When | Value |
|---|---|---|
| `Authorization` | every authenticated request | `Bearer <access token>` |
| `Content-Type` | requests with a JSON body | `application/json` |
| `Accept-Language` | every request | active i18n language |
| `Idempotency-Key` | only when a caller supplies one | caller-generated UUID (`solution.md` §13) |
| `X-CSRF-Token` | `POST /auth/refresh` and `POST /auth/logout` | double-submit token from Phase 07 (D14) |

`fetch` uses `credentials: 'include'` so the refresh cookie is sent. The access token never
goes in a cookie.

### Error envelope consumed

`{ "error": { "code": "VALIDATION_ERROR", "message": "email is required", "details": {}, "reference": "REQ-…" } }`

`ApiError.correlationId` is set from the `X-Correlation-Id` response header, then from
`error.reference`.

### Statuses the client handles centrally

| Status | Client behaviour |
|---|---|
| `401` | single-flight refresh, one retry, then clear session (Phase 14 reacts) |
| `403` | no retry; `ApiError` surfaced so the slice shows an authorization message |
| `409` | no retry; surfaced for conflict-specific copy |
| `429` | no retry; `Retry-After` (when present) attached to `ApiError` for §64 copy |
| `5xx` | retried per the query policy, then surfaced with the correlation ID |

**Correlation ID:** header `X-Correlation-Id`, fallback `error.reference` (Phase 02). Do not
read `x-request-id` or `error.details.correlationId`.

## 7. Configuration & environment variables

Add to `frontend/.env.example` **and** mirror the key into `frontend/.env`
(`.cursor/rules/env-example-sync.mdc`). Never print `.env` contents. This is the only frontend
env var this slice needs; query retry/stale defaults stay as constants in `query-client.ts`.

| Variable | Example | Required | Purpose |
|---|---|---|---|
| `VITE_API_BASE_URL` | `/api/v1` | **yes** | Base URL for every backend call; default changes from `/api` to `/api/v1` |

`vite.config.js` pins `test.env.VITE_API_BASE_URL` so tests do not depend on a developer's local
file — update that pin to `/api/v1` in the same change. `VITE_*` values are inlined into the
browser bundle, so no secret may ever be stored in one.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/shared/api/apiConfig.js` | **New:** validate and expose the base URL |
| `frontend/src/shared/api/apiConfig.test.js` | **New:** valid path, absolute URL, missing, malformed |
| `frontend/src/shared/api/ApiError.js` | **New:** typed error + envelope parsing |
| `frontend/src/shared/api/ApiError.test.js` | **New:** every construction branch |
| `frontend/src/shared/api/apiSession.js` | **New:** in-memory token + session-cleared subscribers |
| `frontend/src/shared/api/apiSession.test.js` | **New:** set/get/clear, subscriber notification |
| `frontend/src/shared/api/refreshClient.js` | **New:** single-flight refresh coordinator |
| `frontend/src/shared/api/refreshClient.test.js` | **New:** concurrency, failure, no recursion |
| `frontend/src/shared/api/apiRequest.js` | **New:** the one `fetch` wrapper |
| `frontend/src/shared/api/apiRequest.test.js` | **New:** success, errors, retry, abort, headers |
| `frontend/src/shared/api/errorMessages.js` | **New:** code → i18n key + failure category |
| `frontend/src/shared/api/errorMessages.test.js` | **New:** known codes, unknown code fallback |
| `frontend/src/shared/api/index.js` | **New:** public surface for features |
| `frontend/src/shared/lib/query-client.js` | **Change:** real retry / stale / error defaults |
| `frontend/src/shared/lib/query-client.test.js` | **New:** retry predicate per status |
| `frontend/src/shared/i18n/locales/en.json` | **Change:** add `errors.unexpected`, `errors.codes.*`, `errors.correlationId` |
| `frontend/.env.example` | **Change:** `VITE_API_BASE_URL=/api/v1` |
| `frontend/.env` | **Change:** mirror the same key |
| `frontend/vite.config.js` | **Change:** pin `test.env.VITE_API_BASE_URL` to `/api/v1` |

## 9. Tests (≥ 80% line and branch)

All tests mock `fetch` with `vi.stubGlobal`; no network call is made.

### Config and errors

- A path base URL and an absolute base URL both resolve; trailing slashes are trimmed.
- A missing or malformed `VITE_API_BASE_URL` throws a message naming the variable.
- `ApiError` carries `code`, `message` and `details` from a well-formed envelope.
- A `500` with an empty body yields `code: 'UNEXPECTED'`, the localized fallback, and never the
  raw transport string; a rejected `fetch` yields `code: 'NETWORK'` with `status: 0`.
- `correlationId` is read from the header, then `error.details`, and stays `undefined` when
  neither is present — never generated.
- `429` attaches `Retry-After` when the header is present and omits it otherwise.

### Session and refresh

- A `401` triggers one refresh and one retry of the original request.
- Two concurrent `401`s trigger exactly **one** refresh call; both requests are retried.
- A failed refresh clears the session, notifies subscribers once, and rethrows the original
  `ApiError`; a `401` on the refresh call itself does not recurse.
- A request marked `skipAuthRefresh` never triggers a refresh, and a retried request that
  returns `401` again is not retried a second time.

### Request behaviour and query defaults

- `Authorization` is attached when a token exists and omitted when it does not.
- A `204` resolves without attempting to parse a body.
- An aborted request rejects with an abort-shaped error distinguishable from a failure.
- `Idempotency-Key` and `Accept-Language` are forwarded as specified.
- The retry predicate returns `false` for `400`, `403`, `404`, `409`, `422`, `429`, allows
  retries for `500` and network failures up to the cap, and mutations never retry.

## 10. Definition of Done

- [ ] `frontend/src/shared/api/` exists with the module layout in §4.1 and a public `index.js`.
- [ ] `apiRequest.ts` is the only file under `frontend/src/` that calls `fetch`.
- [ ] `import.meta.env` is read only in `apiConfig.ts`.
- [ ] `ApiError` exposes `status`, `code`, `message`, `details?`, `correlationId?`.
- [ ] Two concurrent `401`s produce exactly one refresh request (asserted in a test).
- [ ] No user-facing string is hardcoded; all fallbacks come from `errors.*` in `en.json`.
- [ ] `VITE_API_BASE_URL` is documented in `frontend/.env.example`, mirrored into
      `frontend/.env`, and pinned in `vite.config.js` test env.
- [ ] No feature file was modified — no slice is rewired in this phase.
- [ ] `npm run lint` and `npm test` pass in `frontend/`.
- [ ] Coverage for every file this phase touched is ≥ 80% line and ≥ 80% branch.

## 11. Documentation & ADR updates

- `docs/architecture.md` §9: confirm the React → Fastify row still describes the transport this
  client uses (HTTPS JSON, SSE for chat only).
- ADR in `docs/adr/`: "Frontend server-state and HTTP transport" — React Query as the single
  server-state owner, one `fetch` wrapper, refresh handled in the transport rather than in
  components. Write it with this phase; Phase 04 owns the backend stack ADRs.
- No requirements document changes; this phase implements existing requirements.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Correlation ID transport.** **Decided (Phase 02):** header `X-Correlation-Id` and
   `error.reference`. Do not use `x-request-id` or `error.details.correlationId`.
2. **Refresh transport.** **Decided (D14):** httpOnly cookie + CSRF header; no refresh token
   in JSON. This phase uses `credentials: 'include'` and isolates the call in `refreshClient.ts`.
3. **Error-code catalog.** Is there an agreed list of backend `error.code` values (Phase 02)?
   Without it, every unmapped code falls through to the generic category in §4.4.
4. **Base URL default.** Confirm `/api/v1` given the Vite proxy, and that no deployment needs an
   absolute cross-origin URL — that would require CORS and credentialed-cookie handling first.
5. **`Retry-After` semantics.** Seconds or an HTTP date on `429` (`solution.md` §13)? They parse
   differently.
6. **Scope check.** This phase is at the upper end of 1–2 days. Ship the client and query
   defaults first and split the refresh loop only if CSRF wiring slips the budget.
