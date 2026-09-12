# Phase 31 — Repository attach, branch selection & credential lifecycle

- **Layer:** BE
- **Depends on:** Phase 30 (probe, `secretCrypto`, provider resolution)
- **Unblocks:** Phase 32, 34, 36
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §17 (repository connection), §19
  (credentials), §20 (branch management), §86–§87 (audit), §111 (import state), §148–§149
  (secret protection, logging); `frontend/requirments.md` §11 (branch selection), §14
  (validation, no raw errors), §14A (credential lifecycle); `backend/solution.md` §8.2
  (`repos.connect`), §9.2 (audit connect/credential actions); `docs/architecture.md` §5
  (ingest entry), §9 (connections)

## 1. Goal

After this phase the backend **remembers** a repository the probe has already proven readable:
encrypted credentials at rest, selected branch, stable repository identity, and a
**connection status** the UI can show on Sources and project health. Attach validates access
(with the same rules as Phase 30), persists nothing about file trees, and moves the project
from `connecting_repository` to **`source_received`** — not `knowledge_ready` and not
`processing`.

You can see it working with three calls: probe a private repo with a token → `POST` attach
with the same URL, branch, and token → `GET` connection returns provider, branch, and
`connectionStatus: 'connected'` with **no** token field; audit lists `repository.connected`
with repository id and branch only. Replace credential with a new token updates encryption
metadata and writes `repository.credential_replaced` without ever echoing the secret.

## 2. Why this phase is here

Phase 30 is deliberately stateless so “can we read it?” stays reviewable on its own. Product
requirements §17–§20 and frontend §11 / §14A require **persistence**, branch association,
replace/revoke, and audit — none of which belong on the probe route.

It must follow Phase 30 because attach reuses provider inference, outbound safety, and
`secretCrypto`. It must precede Phase 32 (sync/download), Phase 34 (connect dialog attach
step), and Phase 36 (sources tab). Downloading trees and enqueueing ingest stays in Phase 32
so this phase never blocks HTTP on heavy work.

It follows Phase 12 for `Idempotency-Key` on attach and Phase 17 for lifecycle transitions
via `transitionLifecycle` only — HTTP must not reach `processing` or any knowledge-ready state.

## 3. Scope

### In scope

- Mongoose models `RepositoryConnection` and `RepositoryCredential`, each with row
  `status: 'A' | 'D'`.
- **Attach:** authenticated re-validation (probe service with supplied token), persist
  connection + encrypted credential, set selected branch and default-branch flag, update
  `project.sourceConfig`, lifecycle `connecting_repository` → `source_received`.
- **Read connection** for authorized project members (metadata only — never ciphertext or
  plaintext token).
- **Patch branch** on an active connection (validation via probe branch list rules; full
  re-sync after branch change is Phase 32).
- **Replace credential** (new token in body → encrypt → rotate credential row; optional
  server-side re-probe before commit).
- **Revoke / detach** soft-delete connection and credential (`status: 'D'`), clear
  `sourceConfig.repositoryConnectionId` when policy allows, audit revoke.
- **Connection status** field (domain lifecycle, not row `status`) aligned with backend §18 /
  frontend §10 vocabulary where it applies to a *stored* connection (`connected`,
  `authentication_required`, `access_denied`, `unreachable`, …) — updated on attach,
  replace, and re-test; sync failures update it in Phase 32.
- Audit: connect, branch change, credential replace, credential revoke (solution §9.2) — ids,
  provider, branch, result codes only.
- Tenant isolation: every query `{ orgId, projectId, status: 'A' }`.

### Out of scope (owner phase)

- Stateless probe — **Phase 30**.
- Git fetch / archive download, `SourceVersion`, GridFS writes, `repo_sync` job — **Phase 32**.
- Connect dialog, token help copy, branch UI — **Phase 34**.
- Sources tab layout — **Phase 36**.
- Per-project sync interval override — **later** (solution §4.8; MVP constant lives in Phase 32).
- GitHub Enterprise Server, Bitbucket — same as Phase 30.
- In-app rate limiting — **not in this slice** (Phase 12, solution §13.1, architecture §2).

## 4. Design

### 4.1 Module layout

Extend `backend/src/modules/repositories/` (Phase 30). Public surface remains `index.js`.

```text
repositoryConnection.model.js     RepositoryConnection schema + indexes
repositoryCredential.model.js     RepositoryCredential schema + indexes
repositoryAttach.service.js       attach, branch patch, detach orchestration
repositoryCredential.service.js   encrypt/replace/revoke; decrypt only in memory
repositories.routes.js            attach, get, patch branch, replace, revoke (+ probe from 30)
repositories.schemas.js           zod request/response validation
repositories.repository.js        tenant-scoped Mongo access only
```

Handlers own `reply`; services return DTOs or throw `ApiError`.

### 4.2 Collections and responsibility split

**`repositoryConnections`** — one row per attached repository record the product exposes
(how many per project is an open question in §12). Holds everything safe to return to the UI:

```text
orgId, projectId
provider, hostKind, baseUrl|null
repositoryFullName, repositoryWebUrl, visibility|null
selectedBranch, defaultBranchAtAttach
connectionStatus          ← domain field (backend §18)
connectionStatusReasonCode|null
branchChangedAt|null
lastSuccessfulProbeAt|null
credentialId              → active RepositoryCredential
attachedBy, attachedAt
status: 'A' | 'D'
createdBy, updatedBy, timestamps
```

**`repositoryCredentials`** — secret storage only; never joined into list DTOs by default.

```text
orgId, projectId, connectionId
ciphertext, iv, authTag, keyId    ← from secretCrypto (Phase 30)
credentialKind: 'pat'             ← GitHub App vs PAT not decided (§12)
lastValidatedAt|null
revokedAt|null
status: 'A' | 'D'
```

Replace = soft-delete prior credential row (`status: 'D'`), insert new row, point
`connection.credentialId` at the new id. Revoke = soft-delete credential + connection.

### 4.3 Attach sequence

```text
1. Load project (org-scoped, status A); require repos.connect + project membership (Phase 18).
2. Require Idempotency-Key (Phase 12).
3. Validate body: repositoryUrl, selectedBranch, accessToken (token required for private attach).
4. Call repositoryProbe.service with URL + token (same orchestration as Phase 30).
     probeStatus != 'connected' → map to 409 CONNECTION_NOT_VERIFIED or 200-shaped error
     per Phase 30 §12 item 1 (not decided here — do not pick silently).
5. Assert selectedBranch exists in probe branch list (or equals default when list truncated —
   frontend §11 / REPO_BRANCH_LIST_LIMIT from Phase 30).
6. Transaction:
     upsert RepositoryConnection + RepositoryCredential (encrypt token via secretCrypto)
     project.sourceConfig ← { sourceType: 'repository', repositoryConnectionId }
     transitionLifecycle: connecting_repository → source_received
       (or awaiting_source → source_received when attach follows upload-only project)
     audit repository.connected
7. Return 201 connection DTO (no token, no ciphertext).
```

Attach **does not** insert `SourceVersion`, **does not** enqueue `ingest` or `repo_sync`, and
**does not** transition to `processing`. Phase 32 owns the first download and job enqueue.

### 4.4 Branch patch

Authorized caller sends `{ "selectedBranch": "release/2.4" }`. Service re-runs probe with
**decrypted** token in memory only, verifies branch exists, updates connection row, audits
`repository.branch_changed`. It does **not** download content; Phase 32 treats branch change
as a full-tree sync event (solution §4.8B).

### 4.5 Credential replace, revoke, re-test

- **Replace:** body carries new `accessToken` only. Encrypt, rotate credential row, optional
  inline probe → update `connectionStatus`. Audit `repository.credential_replaced`. Never
  return or log token (frontend §14A write-only fields).
- **Revoke:** soft-delete connection + credential; clear `project.sourceConfig` repository
  pointer when no other active connection remains (if many connections are allowed — §12).
  Audit `repository.credential_revoked`.
- **Re-test:** `POST .../repositories/connection/re-test` decrypts, runs probe, updates
  `connectionStatus` only — no lifecycle side effects.

### 4.6 Error mapping

Reuse Phase 30 `probeErrorMap` for provider-facing failures; map to HTTP/API codes without
provider body text in `error.message` (frontend §14). Operational detail → structured log with
correlation id; redact `accessToken` (Phase 30 logger paths).

### 4.7 Idempotency

Attach participates in Phase 12 middleware (`requireIdempotencyKey: true`). Same key replays
the stored `201` body; no second connection row.

## 5. Data model changes

Two new collections; both use Phase 03 base schema fields and **`status: 'A' | 'D'`**.

**Indexes (partial `status: 'A'` where noted):**

- `repositoryConnections`: unique `{ orgId, projectId, repositoryFullName, baseUrl }` — **only
  if** product confirms one connection per project (§12); otherwise non-unique plus app-level rule.
- `repositoryConnections`: `{ orgId, projectId, status }` for get/list.
- `repositoryCredentials`: `{ orgId, projectId, connectionId, status }`.

**`projects`:** no schema change; `sourceConfig.repositoryConnectionId` already reserved in
Phase 17.

Update `docs/data-model.md` in the implementation change when this ships.

## 6. API contract — PROPOSED (needs approval before implementation)

Base path: `/api/v1/projects/:projectId/repositories`. JWT + project ACL on all routes.
Permission: **`repos.connect`** unless noted.

### `POST /api/v1/projects/:projectId/repositories`

Attach after successful probe. **Idempotency-Key:** required.

```json
{
  "repositoryUrl": "https://github.com/acme/payments",
  "selectedBranch": "main",
  "accessToken": "<required when probe required auth; never stored in response>"
}
```

**Response `201`:**

```json
{
  "connection": {
    "id": "rcn_01J...",
    "provider": "github",
    "hostKind": "github",
    "baseUrl": null,
    "repository": {
      "fullName": "acme/payments",
      "webUrl": "https://github.com/acme/payments",
      "visibility": "private"
    },
    "selectedBranch": "main",
    "defaultBranch": "main",
    "connectionStatus": "connected",
    "attachedAt": "2026-09-12T16:00:00.000Z"
  },
  "project": {
    "lifecycleStatus": "source_received",
    "sourceConfig": { "sourceType": "repository", "repositoryConnectionId": "rcn_01J..." }
  }
}
```

**Errors:** `400 VALIDATION_ERROR`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`
(project), `409 CONNECTION_NOT_VERIFIED` (probe did not reach `connected`),
`409 IDEMPOTENCY_IN_FLIGHT`, `409 INVALID_STATE_TRANSITION`.

### `GET /api/v1/projects/:projectId/repositories/connection`

Permission: **`projects.view`** (read metadata) or `repos.connect`. Returns the active
connection or `404` when none.

Same `connection` object as attach; adds `lastSuccessfulProbeAt`, `connectionStatusReasonCode`
when set. **Never** includes `accessToken`, ciphertext, or decrypt hints.

### `PATCH /api/v1/projects/:projectId/repositories/connection/branch`

```json
{ "selectedBranch": "develop" }
```

**Response `200`:** updated `connection` object.

### `POST /api/v1/projects/:projectId/repositories/credentials/replace`

```json
{ "accessToken": "<new token>" }
```

**Response `200`:** `{ "connection": { ... }, "connectionStatus": "connected" }`.

### `POST /api/v1/projects/:projectId/repositories/credentials/revoke`

No body. Soft-detaches repository. **Response `204`**.

### `POST /api/v1/projects/:projectId/repositories/connection/re-test`

Decrypt-in-memory probe; **Response `200`:** `{ "connectionStatus", "reason"? }`.

**Errors (all routes):** standard envelope; no secret values in `details`.

## 7. Configuration & environment variables

No new env keys beyond Phase 30 (`REPO_CREDENTIAL_ENCRYPTION_KEY`, optional `REPO_CREDENTIAL_KEY_ID`).

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `REPO_ATTACH_PROBE_TIMEOUT_MS` | reuse `REPO_PROBE_TIMEOUT_MS` | attach service | Same outbound budget as probe |
| `REPO_CREDENTIAL_MAX_ACTIVE_PER_CONNECTION` | `1` | credential service | One active secret row per connection |

**No in-app rate-limit constants** on these routes (architecture §2, Phase 12).

## 8. Files to create or change

Each new source file ships colocated `*.test.js`.

| Path | Purpose |
|---|---|
| `backend/src/modules/repositories/repositoryConnection.model.js` (+ test) | **New:** connection schema |
| `backend/src/modules/repositories/repositoryCredential.model.js` (+ test) | **New:** encrypted credential schema |
| `backend/src/modules/repositories/repositoryAttach.service.js` (+ test) | **New:** attach, branch, detach |
| `backend/src/modules/repositories/repositoryCredential.service.js` (+ test) | **New:** encrypt/replace/revoke/decrypt boundary |
| `backend/src/modules/repositories/repositories.repository.js` (+ test) | **New:** tenant-scoped CRUD |
| `backend/src/modules/repositories/repositories.schemas.js` | **Extend:** attach/branch/replace bodies |
| `backend/src/modules/repositories/repositories.routes.js` (+ test) | **Extend:** routes above |
| `backend/src/modules/repositories/index.js` | Export new services/types |
| `backend/src/modules/projects/projects.service.js` | Call `transitionLifecycle` on attach |
| `backend/src/modules/audit/audit.actions.js` | Add `repository.*` actions |
| `backend/src/http/routes.js` | Already registers repository routes from Phase 30 |
| `docs/data-model.md` | Document new collections |

## 9. Tests (≥ 80% line and branch)

Probe and `secretCrypto` stay mocked at boundaries; no live GitHub/GitLab in CI.

### Unit

- Attach encrypts token via `secretCrypto`; repository never stores plaintext.
- Replace rotates credential row; old row `status: 'D'`.
- Revoke sets connection + credential `status: 'D'` and clears `sourceConfig` when appropriate.
- Branch patch rejects branch not in probe result.
- `connectionStatus` updates on failed re-test without throwing raw provider errors.

### Integration (Fastify `app.inject`)

- Happy attach after mocked `connected` probe → `201`, lifecycle `source_received`, audit row.
- Attach without token when probe requires auth → `409` or validation error (per approved §30 Q1).
- Duplicate `Idempotency-Key` → same `201`, one connection row.
- `GET` connection never contains token substrings from fixture.
- Missing `repos.connect` → `403`; cross-org project id → `404`.
- Logs and responses scanned for fixture token — must not appear.

### Unhappy paths

- Probe returns `access_denied` on attach → no persist, no lifecycle change.
- Invalid lifecycle (e.g. `archived` project) → `409 INVALID_STATE_TRANSITION`.
- Tampered ciphertext on replace path → decrypt failure surfaced as `503` or `409` (catalog TBD).

## 10. Definition of Done

- [ ] Attach persists connection + encrypted credential; **no** `SourceVersion` or GridFS write.
- [ ] Successful attach sets lifecycle **`source_received`**, not `knowledge_ready` / `processing`.
- [ ] Token never appears in response, audit context, or logs (asserted in tests).
- [ ] Branch patch and credential replace/revoke/re-test routes behave as §6.
- [ ] `Idempotency-Key` required on attach; duplicates replay safely.
- [ ] Row `status: 'A' | 'D'` on both collections; list/get exclude `D`.
- [ ] Audit actions for connect, branch change, replace, revoke (no secrets).
- [ ] No in-app rate limiting added on these routes.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch on touched files.

## 11. Documentation & ADR updates

- `docs/architecture.md` §9: extend connections table — Fastify persists repo connection;
  Worker still performs `repo_sync` (Phase 32).
- `docs/data-model.md`: `RepositoryConnection`, `RepositoryCredential` fields and indexes.
- ADR (if not covered by Phase 30 encryption ADR): **credential rotation** — replace creates a
  new row; old ciphertext retained soft-deleted until retention (Phase 60).

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

**Carried from Phase 30 §12 (unchanged — not answered here):**

1. **Status codes for non-connected probes** — does attach reuse `200` + `probeStatus`, or
   map failures to `404` / `403`?
2. **Provider SDK vs plain HTTP** — attach reuses whatever Phase 30 implements.
3. **Token scopes** — GitHub `repo` vs fine-grained; GitLab `api` vs `read_api` + `read_repository`
   (frontend §12 vs backend §19 minimum scope).
4. **Token handoff to attach** — UI resends token on attach vs short-lived server-side probe handle.
5. **Rate-limit class** — N/A for in-app limits in this slice; probe class remains Phase 30 concern.
6. **Probe auditing** — should failed attach-time probes be audited?
7. **Self-hosted TLS** — private CA / client certificates for stored connections.

**Repository attach-specific:**

8. **One connection per project vs many** (README Part G; requirements §17 step 7 implies content
   retrieval but not cardinality).
9. **GitHub App vs personal access token** — requirements describe PAT-style tokens; App install
   flow is not specified.
10. **Attach idempotency scope** — same key with *different* branch/token: replay vs `409` conflict.
11. **Re-test permission** — `repos.connect` only, or `projects.view` for read-only status check?
12. **Detach vs project lifecycle** — should revoke move project back to `awaiting_source` when
    no source versions exist yet?
