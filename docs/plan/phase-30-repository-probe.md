# Phase 30 — Repository probe & credential security

- **Layer:** BE
- **Depends on:** Phase 12 (rate limiting, idempotency), Phase 17 (project model, lifecycle)
- **Unblocks:** Phase 31, 32, 34
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §17 (repository connection), §18
  (authentication states), §19 (credentials), §20 (branch management), §148 (secret
  protection), §149 (logging); `frontend/requirments.md` §10 (connection flow and probe
  states), §11 (branch selection), §12–§13 (token step and links), §14 (validation, no raw
  technical errors); `backend/solution.md` §8.2 (permissions), §13.1 (rate-limit classes);
  `docs/architecture.md` §5 (ingest entry), §9 (connections)

## 1. Goal

After this phase the backend answers the one question the frontend cannot: **"what is this
repository URL, and can we read it?"** A single probe endpoint takes a bare URL, infers GitHub,
GitLab.com or a self-hosted GitLab instance, tries anonymous access first, reports one of the
exact states frontend §10 requires, and on success returns the repository identity, its
branches, its default branch and an optional README-derived description.

You can see it working with two calls: a public GitHub URL returns `probeStatus: "connected"`
with a branch list; a private URL returns `authentication_required`, and the same call with a
token in the body returns `connected`. Nothing is persisted and no token value reaches a log
line or a response.

## 2. Why this phase is here

Frontend §10 forbids a provider picker — the UI sends a URL and the backend decides. That
inference, the anonymous-then-authenticated sequence and the five probe states are backend
behaviour, so they must exist before the dialog in Phase 34 is rewired and before Phase 31 can
attach anything; attaching a repository the system has never successfully read produces a
project that can never ingest.

It follows Phase 12 because an endpoint that makes outbound calls on user-supplied input needs a
rate-limit class from day one, and Phase 17 because the probe is project-scoped and checked
against `repos.connect`. It is deliberately **stateless**: splitting "can we read it" from
"remember that we read it" keeps this change reviewable and leaves the collection, credential
lifecycle and audit trail to Phase 31.

## 3. Scope

### In scope

- Provider inference from a URL: `github.com`, `gitlab.com`, any other host treated as a
  self-hosted GitLab instance, with the instance base URL returned to the caller.
- URL normalisation: HTTPS URLs, `.git` suffixes, trailing slashes, SSH-style
  `git@host:owner/repo.git`, nested GitLab groups (`group/subgroup/repo`).
- Anonymous probe first; authenticated re-probe when a token is supplied.
- The probe states of backend §18 / frontend §10 with user-facing reasons.
- Branch listing and default branch retrieval (backend §20), capped and paginated.
- Optional confirm-step data: repository description, or a README-derived one when available.
- Credential rules (backend §19, §148): token in the request body only, held in memory for the
  call, never echoed, never logged, never stored here; the shared encryption helper Phase 31
  needs for storage is built and tested in this phase.
- Outbound safety: timeouts, size caps, redirect limits, private/loopback host blocking.
- Error mapping that keeps raw provider errors out of the primary message (frontend §14).

### Out of scope (owner phase)

- Persisting a connection, credential, branch or sync metadata — **Phase 31**.
- Scheduled and manual sync, commit comparison, `nextDueAt` — **Phase 32**.
- Downloading repository content (clone / archive) — **Phase 32**, in the worker.
- Connect dialog, token help copy, branch control — **Phase 34**.
- GitHub Enterprise Server and Bitbucket: requirements name GitHub, GitLab.com and self-hosted
  GitLab only, so anything else resolves to an unsupported-provider reason.

## 4. Design

### 4.1 Module layout

New domain module `backend/src/modules/repositories/` (`routes + service + providers + tests`,
public surface in `index.ts`). It has no Mongoose repository yet; Phase 31 adds one.

```text
repositories.routes.ts        POST /projects/:projectId/repositories/probe
repositories.schemas.ts       zod request/response validation
repositoryProbe.service.ts    resolve → anonymous → authenticated orchestration
providers/providerResolver.ts URL → { provider, baseUrl, ownerPath, repoSlug }
providers/githubProbe.ts      GitHub REST calls
providers/gitlabProbe.ts      GitLab REST calls (SaaS and self-hosted share this)
providers/probeErrorMap.ts    provider status → probeStatus + reason code
providers/outboundHttp.ts     timeout, redirect, size and host guards
```

### 4.2 Provider inference (frontend §10)

```text
github.com   → provider 'github', baseUrl null
gitlab.com   → provider 'gitlab', baseUrl null
other host   → provider 'gitlab', baseUrl 'https://<host>'   (self-hosted)
unparseable  → 400 VALIDATION_ERROR, no outbound call
```

The self-hosted assumption is verified rather than trusted: the first call to an unknown host is
the GitLab project lookup, and a host that does not answer as a GitLab API returns `unreachable`
with reason `provider_not_supported`. The resolved `baseUrl` is returned in **every** state,
because frontend §12 builds the self-hosted "Open token page" link from it.

### 4.3 Probe sequence and states

```text
1. resolve URL                          → 400 on a malformed URL
2. anonymous repository lookup
     200                                → step 4
     401 / 403 / 404 with no token      → 'authentication_required'
3. token supplied → repeat with token
     200 → step 4 | 401 → 'authentication_required'
     403 → 'access_denied' | 404 → 'not_found'
4. branches + default branch + optional description → 'connected'
```

| `probeStatus` | Meaning | Reason codes |
|---|---|---|
| `connected` | Readable; identity and branches returned | — |
| `authentication_required` | Private or gated; a token is needed | `token_missing`, `token_invalid` |
| `access_denied` | Token valid but lacks access to this repository | `insufficient_scope` |
| `not_found` | Authenticated and still unresolved | `repository_not_found` |
| `unreachable` | DNS/TLS/timeout/5xx/provider limit | `network_unreachable`, `provider_unavailable`, `provider_rate_limited`, `provider_not_supported`, `host_not_allowed` |

`connecting` / `verifying` in frontend §10 are client-side in-flight states; the backend never
returns them, and Phase 34 renders them from the mutation's pending state.

An anonymous `404` maps to `authentication_required`, not `not_found`: both providers return
`404` for a private repository to an anonymous caller, and saying "not found" when the real
answer is "sign in" is the most common failure of this flow.

### 4.4 Branches and confirm-step data (backend §20, frontend §11)

Branches come from the provider's branch endpoint with pagination, capped at
`REPO_BRANCH_LIST_LIMIT` (default 200). At the cap the response sets `branchesTruncated: true`
so the UI can say so rather than imply completeness (frontend §98); the default branch always
stays in the list. `description` is the provider's description, or — when empty — the first
non-heading paragraph of a bounded README read. Any failure yields `null` instead of failing the
probe, because frontend §11 marks the field optional.

### 4.5 Credential rules (backend §19, §148, §149)

The token arrives in the request body over HTTPS (never a query string), lives in a local
variable and one outbound `Authorization` header, and is added by field name to the Phase 02
log redaction paths. Provider response bodies are read for the fields above and never logged or
forwarded. Only read-only provider endpoints are called, matching §19's minimum-scope rule; the
exact scopes we ask users for are an open question in section 12.

`backend/src/platform/secretCrypto.ts` lands here even though nothing is stored yet:
`encryptSecret` / `decryptSecret` over Node's built-in `crypto` with AES-256-GCM, a per-value
random IV, and a key id stored with the ciphertext so rotation can find old values. Building it
now lets "encrypted at rest, decrypted in memory only" be tested on its own and keeps Phase 31
focused on lifecycle.

### 4.6 Outbound safety and error mapping

`outboundHttp` enforces a total timeout, at most three same-host redirects, a response size cap,
and rejection of loopback, link-local and private addresses unless
`REPO_PROBE_ALLOW_PRIVATE_HOSTS` is set for local development. `probeErrorMap` is the only place
that sees a provider status or body; it returns `{ probeStatus, reasonCode }` and no provider
text, status code or URL is copied into the user-facing message (frontend §14). Operational
detail goes to the log with the Phase 02 correlation id.

## 5. Data model changes

**None.** The probe persists nothing. `RepositoryConnection` and `RepositoryCredential`, both
carrying row `status: 'A' | 'D'`, arrive in Phase 31.

## 6. API contract — PROPOSED (needs approval before implementation)

### `POST /api/v1/projects/:projectId/repositories/probe`

- **Auth:** JWT. **Permission:** `repos.connect` (solution §8.2) plus project membership.
- **Rate limit:** the repository class from Phase 12 — proposed 10/min per user (solution §13.1).
- **Idempotency:** none; the probe is a read and repeating it is expected.

```json
{
  "repositoryUrl": "https://gitlab.example.com/group/subgroup/payments",
  "accessToken": "<optional; never stored, never echoed>"
}
```

- **Response `200` — connected:**

```json
{
  "probeStatus": "connected",
  "provider": "gitlab",
  "hostKind": "gitlab_self_hosted",
  "baseUrl": "https://gitlab.example.com",
  "repository": {
    "fullName": "group/subgroup/payments",
    "webUrl": "https://gitlab.example.com/group/subgroup/payments",
    "visibility": "private",
    "description": "Payment orchestration service."
  },
  "defaultBranch": "main",
  "branches": ["main", "develop", "release/2.4"],
  "branchesTruncated": false,
  "tokenUsed": true
}
```

- **Response `200` — every non-connected state:**

```json
{
  "probeStatus": "authentication_required",
  "provider": "gitlab",
  "hostKind": "gitlab_self_hosted",
  "baseUrl": "https://gitlab.example.com",
  "repository": { "fullName": "group/subgroup/payments" },
  "reason": {
    "code": "token_missing",
    "message": "This repository looks private or requires authentication."
  }
}
```

`repository.fullName` is echoed from the URL so frontend §12 can say "acme/payments looks
private"; unknown fields are omitted rather than guessed.

- **Errors:** `400 VALIDATION_ERROR` (missing/malformed URL, unsupported scheme),
  `401 UNAUTHENTICATED`, `403 FORBIDDEN` (no `repos.connect` or not a member), `404 NOT_FOUND`
  (project outside the caller's organization or `status: 'D'`), `429 RATE_LIMITED` — all in the
  existing `{ error: { code, message, details? } }` envelope.

Returning `200` for `not_found` and `access_denied` is deliberate — the probe succeeded in
determining the state, and the UI needs provider, base URL and reason in every case. See
section 12; this needs approval.

## 7. Configuration & environment variables

Add to `backend/.env.example` **and** mirror into `backend/.env`
(`.cursor/rules/env-example-sync.mdc`). Never print `.env` contents.

| Variable | Example | Required | Purpose |
|---|---|---|---|
| `REPO_CREDENTIAL_ENCRYPTION_KEY` | 32-byte base64 value | **yes** | AES-256-GCM key; startup fails if absent or wrong length |
| `REPO_CREDENTIAL_KEY_ID` | `k1` | no | Key id stored with each ciphertext for rotation |
| `REPO_PROBE_TIMEOUT_MS` | `10000` | no | Total budget for one provider call |
| `REPO_PROBE_ALLOW_PRIVATE_HOSTS` | `false` | no | Allow private/loopback hosts (development only) |
| `REPO_BRANCH_LIST_LIMIT` | `200` | no | Maximum branches returned |
| `REPO_README_MAX_BYTES` | `65536` | no | Cap on the README read for the optional description |
| `REPO_PROBE_RATE_LIMIT_PER_MIN` | `10` | no | Per-user probe budget |

## 8. Files to create or change

Each new source file ships its colocated `*.test.ts` in the same change.

| Path | Purpose |
|---|---|
| `backend/src/platform/secretCrypto.ts` (+ test) | **New:** AES-256-GCM encrypt/decrypt with key id |
| `backend/src/modules/repositories/providers/providerResolver.ts` (+ test) | **New:** URL → provider, base URL, owner path |
| `backend/src/modules/repositories/providers/githubProbe.ts` (+ test) | **New:** GitHub repository, branches, README |
| `backend/src/modules/repositories/providers/gitlabProbe.ts` (+ test) | **New:** GitLab SaaS and self-hosted equivalents |
| `backend/src/modules/repositories/providers/probeErrorMap.ts` (+ test) | **New:** provider status → state + reason code |
| `backend/src/modules/repositories/providers/outboundHttp.ts` (+ test) | **New:** timeout, redirect, size, host guards |
| `backend/src/modules/repositories/repositoryProbe.service.ts` (+ test) | **New:** probe orchestration |
| `backend/src/modules/repositories/repositories.schemas.ts` | **New:** zod request/response schemas |
| `backend/src/modules/repositories/repositories.routes.ts` (+ test) | **New:** the probe route |
| `backend/src/modules/repositories/index.ts` | **New:** public surface |
| `backend/src/http/routes.ts` | Register `repositoryRoutes` |
| `backend/src/platform/config.ts` (+ test) | Add the `repositories` config group |
| `backend/src/platform/logger.ts` | Add `accessToken` to the redaction paths |
| `backend/src/test/appConfig.ts` | Extend the fixture with the `repositories` group |
| `backend/.env.example` / `backend/.env` | Document and mirror the new variables |

## 9. Tests (≥ 80% line and branch)

Provider calls are mocked at the `outboundHttp` boundary; no test reaches the network.

### Unit

- `providerResolver` maps `github.com`, `gitlab.com` and an unknown host, returning a base URL
  only for self-hosted GitLab; it normalises `.git`, trailing slashes, SSH form and nested
  groups, and rejects non-HTTP schemes and URLs with embedded credentials.
- `probeErrorMap` returns `authentication_required` for an anonymous `404`, `not_found` for an
  authenticated `404`, `access_denied` for `403`, `unreachable` for timeouts and `5xx`, and
  `unreachable` for an unmapped status rather than throwing.
- `secretCrypto` round-trips a value, produces different ciphertext per call, rejects a tampered
  payload, and fails loudly on a wrong-length key.
- `outboundHttp` aborts on timeout, refuses a cross-host redirect, stops at the size cap, and
  rejects a loopback address when private hosts are disallowed.
- Branch reading paginates, sets `branchesTruncated` at the cap, and keeps the default branch.
- README extraction returns `null` on any failure instead of throwing.

### Integration (Fastify `app.inject`)

- Public repository without a token → `connected` with branches.
- Private repository without a token → `authentication_required` with `baseUrl` present.
- Valid token → `connected`; invalid token → `token_invalid`; unscoped token → `access_denied`.
- Provider timeout → `unreachable`, with no provider text or status code in the body.
- Malformed URL → `400` and no outbound call is made.

### Unhappy paths that must be covered

- Missing `repos.connect` → `403`; another organization's project → `404`; `status: 'D'`
  project → `404`; over the rate limit → `429` with `details.retryAfterSec`.
- Captured log output and the serialised response are scanned for the token fixture value and
  must not contain it.

## 10. Definition of Done

- [ ] A repository URL alone determines the provider; no request field asks for one.
- [ ] All five probe states of backend §18 / frontend §10 are reachable and tested.
- [ ] `baseUrl` is returned for self-hosted GitLab in every state, including
      `authentication_required`.
- [ ] Branch list and default branch are returned on `connected`, with truncation flagged.
- [ ] The token never appears in a response, log line or error payload (asserted).
- [ ] Nothing is persisted; no new collection exists after this phase.
- [ ] `secretCrypto` is the only encryption entry point and is covered by tests.
- [ ] Private/loopback hosts are rejected unless configuration allows them.
- [ ] New variables are in `backend/.env.example` and mirrored into `backend/.env`.
- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass; coverage for touched files is
      ≥ 80% line and ≥ 80% branch.

## 11. Documentation & ADR updates

- `docs/architecture.md` §9: add the "Fastify → GitHub/GitLab (probe only)" row and keep the
  existing "Worker → GitHub/GitLab" row for `repo_sync`.
- ADR: "Repository credential encryption" — AES-256-GCM via Node `crypto`, key from environment,
  key id stored with each ciphertext, no external KMS in this slice.
- ADR: "Provider inference from repository URL" — why there is no provider picker and why an
  unknown host is treated as self-hosted GitLab.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Status codes for non-connected probes.** Is `200` with a `probeStatus` body acceptable, or
   must `not_found` / `access_denied` be `404` / `403`?
2. **Provider SDK vs plain HTTP.** `solution.md` names no GitHub/GitLab client library. The
   proposal uses the runtime `fetch` with hand-written calls and no new dependency.
3. **Token scopes.** Frontend §12 names `repo` (GitHub) and `api` (GitLab), but backend §19 says
   request only what is needed — `read_api` + `read_repository` and a fine-grained GitHub token
   are narrower. Which do we instruct users to create?
4. **Token handoff to attach.** As proposed the UI holds the token in memory and resends it to
   the Phase 31 attach endpoint; the alternative is a short-lived server-side probe handle so
   the secret crosses the wire once.
5. **Rate-limit class.** Reuse the 10/min sync class or add a probe class? A four-step flow can
   legitimately probe twice per attempt.
6. **Probe auditing.** Solution §9.2 audits connect and credential changes, not probes. Should
   failed probes be audited to detect credential stuffing?
7. **Self-hosted TLS.** Do any target instances use a private CA or client certificates? That
   would add validated configuration here.
