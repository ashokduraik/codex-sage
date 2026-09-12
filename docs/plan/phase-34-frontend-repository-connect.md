# Phase 34 — Frontend repository connection slice

- **Layer:** FE
- **Depends on:** Phase 19 (frontend projects slice), Phase 31 (repository attach & credentials)
- **Unblocks:** — (README index lists none required; Phase 36 benefits from real connection data)
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §10 (connection flow & probe states),
  §11 (branch selection), §12–§13 (token step & token page links), §14 (validation, no raw
  errors), §14A (credential lifecycle), §89–§90 (loading & error states), §98 (technical realism);
  `backend/requirments.md` §17–§20; decision **D7**

## 1. Goal

After this phase `ConnectRepositoryDialog` drives the real probe and attach flow: URL-only input
(no provider picker), server-returned probe states, token step when required, branch selection,
and attach with credentials never shown again after submit. Client-only **Connecting** and
**Verifying** states appear while mutations are pending — the backend never returns those
(Phase 30 §4.3).

You can see it working by connecting a repository from project creation or Sources: public URL
→ branches → confirm → attach; private URL → token help with **Open token page** link built from
`baseUrl` → re-probe → attach; replace/revoke flows on Sources defer detailed UX to Phase 36
but attach path is complete here.

## 2. Why this phase is here

Phase 30 proves read access; Phase 31 persists connection and encrypted credentials. Phase 19
opens `ConnectRepositoryDialog` with a real `projectId` but the dialog still runs `mockProbe`
inside the file. Without this slice, repository projects stay fictional while upload and jobs
move to real APIs.

It must follow Phase 31 so attach has a defined contract. It must not implement sync scheduling
UI (Phase 32) or invent token scopes beyond what product confirms (Phase 30 §12 question 3).

## 3. Scope

### In scope

- Repository API module: probe (Phase 30) + attach (Phase 31 **PROPOSED**).
- React Query mutations for probe and attach; optional query for connection summary when Phase 31
  exposes GET (consumed here if available — otherwise attach response seeds cache).
- `ConnectRepositoryDialog.jsx` rewired: steps URL → probe → token (conditional) → confirm
  (identity, branches, optional description) → attach.
- Inline token help (`TokenHelp`) with i18n; links use probe `baseUrl` for self-hosted GitLab
  (frontend §12–§13).
- Map `probeStatus` + `reason.code` to localized primary messages — never raw provider text
  (frontend §14).
- Remove mock probe and `useAppData` from this dialog.
- Tests: all probe states, pending UI, attach errors, token field write-only behavior.

### Out of scope (owner phase)

- Sources tab credential replace/revoke/re-test UI — **Phase 36** (§14A); this phase may export
  shared probe/attach hooks for reuse there.
- Manual sync button and `connectionStatus` from sync jobs — **Phase 32**.
- Provider picker — **forbidden** (frontend §10).
- Displaying stored tokens — **forbidden** (frontend §14, §14A).
- Processing center / ingest progress — **Phase 35**.

## 4. Design

### 4.1 Feature layout

```text
frontend/src/features/projects/
  api/repositoriesApi.js       probe + attach requests
  api/repositoryTypes.js       probe/attach DTOs (mirror Phase 30/31 §6)
  hooks/useRepositoryProbe.js  mutation, maps probeStatus → UI step
  hooks/useRepositoryAttach.js mutation + idempotency if Phase 31 requires
  repositoryProbeMap.js        probeStatus + reason.code → i18n keys (single table)
  ConnectRepositoryDialog.jsx  step machine UI
```

Step machine (client states in **bold**):

```text
url → **connecting** (probe pending) →
  connected? → confirm (branches)
  authentication_required? → token → **verifying** (re-probe pending) → confirm | error
  not_found | access_denied | unreachable → error panel with mapped copy
confirm → **connecting** (attach pending) → success → close + invalidate project
```

**Connecting / Verifying** are rendered only while `isPending` on the relevant mutation — not
returned in JSON (Phase 30 §4.3).

### 4.2 Probe mapping (anti-invention)

All comparisons to backend probe codes live in `repositoryProbeMap.js`:

| Backend `probeStatus` | UI step | Notes |
|---|---|---|
| `connected` | Confirm | Branches + `defaultBranch` from response |
| `authentication_required` | Token | Use `repository.fullName` in copy when present |
| `access_denied` | Error | Map `reason.code` e.g. `insufficient_scope` |
| `not_found` | Error | |
| `unreachable` | Error | Network / provider / rate limit reasons |

Unknown `probeStatus` or `reason.code` → neutral unknown i18n key (frontend §98).

HTTP status for non-connected probes: Phase 30 proposes **`200` with body** (§12 Q1) — frontend
must not assume `404`/`403` HTTP for probe failures until approved.

### 4.3 Token step and scopes (do not invent)

Inline help follows frontend §12 structure (why, PAT, navigation, scope, paste, usage). **Minimum
scope text in i18n must stay generic** until product resolves Phase 30 §12 question 3:

- GitHub: requirements example **`repo`** vs backend §19 least privilege / fine-grained token.
- GitLab: requirements example **`api`** vs `read_api` + `read_repository`.

Document in UI copy: “request only scopes your administrator documents” — do not assert a scope
the backend has not confirmed.

Token input: `type="password"`, autocomplete off, cleared on dialog close; never copied to
localStorage or query strings.

### 4.4 Attach hand-off (Phase 31 **PROPOSED**)

Attach sends repository identity, selected branch, and token (unless Phase 31 probe-handle
handoff is chosen — Phase 30 §12 Q4). On success:

- Invalidate `['projects', 'detail', projectId]` and repository connection query key.
- Do not store token in React Query cache.
- Lifecycle badge moves when backend sets `connecting_repository` → `source_received` (worker
  sync is Phase 32 — UI must not claim “download complete” here).

### 4.5 Action feedback

Every Connect / Continue / Verify button: loader, `disabled`, `aria-busy`, `role="alert"` on
failure with `error.message`. Back navigation clears token from state but does not log it.

### 4.6 Responsiveness

Multi-step dialog stacks on 375 px; branch `Select` remains usable; external link buttons wrap.

## 5. Data model changes

**None** (frontend).

## 6. API contract — PROPOSED (needs approval before implementation)

Frontend consumes the following **without adding backend routes**. Each remains **PROPOSED**
until the owning phase is approved.

### Consumed: `POST /api/v1/projects/:projectId/repositories/probe` (Phase 30 §6)

- **Permission:** `repos.connect` + membership.
- **Body:** `{ "repositoryUrl", "accessToken?" }`.
- **Response `200`:** `probeStatus`, `provider`, `baseUrl`, `repository`, `defaultBranch`,
  `branches`, `branchesTruncated`, `reason?`, etc.
- Token never echoed; errors use standard envelope on `400`/`401`/`403`/`404`/`429`.

### Consumed: attach and related (Phase 31 — **PROPOSED**, paths to confirm)

Phase 31 (missing plan Part G) proposes project-scoped attach after successful probe. Until
`phase-31-repository-attach-and-credentials.md` is approved, treat this table as **indicative**:

| Method | Path (PROPOSED) | Purpose |
|---|---|---|
| `POST` | `/api/v1/projects/:projectId/repositories` | Attach connection + branch + credential |
| `GET` | `/api/v1/projects/:projectId/repositories/connection` | Read connection for confirm refresh |
| `PATCH` | `/api/v1/projects/:projectId/repositories/connection/branch` | Branch change (Sources — Phase 36) |

Attach request shape (**PROPOSED** — confirm with Phase 31):

```json
{
  "repositoryUrl": "https://github.com/acme/payments",
  "accessToken": "<required when private; never returned>",
  "branch": "main",
  "idempotencyKey": "<if Phase 31 requires Idempotency-Key header instead, follow backend>"
}
```

Attach response (**PROPOSED**): connection id, `connectionStatus`, selected branch, repository
identity — **no secret fields**.

Frontend TypeScript/JSDoc types use known codes plus `string` for forward compatibility.

## 7. Configuration & environment variables

**None new.**

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/projects/api/repositoriesApi.js` | **New:** probe + attach |
| `frontend/src/features/projects/api/repositoriesApi.test.js` | **New:** |
| `frontend/src/features/projects/api/repositoryTypes.js` | **New:** DTOs |
| `frontend/src/features/projects/hooks/useRepositoryProbe.js` | **New:** |
| `frontend/src/features/projects/hooks/useRepositoryAttach.js` | **New:** |
| `frontend/src/features/projects/hooks/useRepositoryProbe.test.jsx` | **New:** state mapping |
| `frontend/src/features/projects/repositoryProbeMap.js` | **New:** probeStatus → i18n |
| `frontend/src/features/projects/repositoryProbeMap.test.js` | **New:** |
| `frontend/src/features/projects/ConnectRepositoryDialog.jsx` | Remove mockProbe / useAppData |
| `frontend/src/features/projects/ConnectRepositoryDialog.test.jsx` | All probe states + attach |
| `frontend/src/features/projects/index.js` | Export hooks if needed by Phase 36 |
| `frontend/src/shared/i18n/locales/en.json` | Probe errors, token help, step labels |

`ConnectRepositoryDialog.test.jsx` already exists — rewrite against mocked API client.

## 9. Tests (≥ 80% line and branch)

### Unit

- `repositoryProbeMap` covers five probe statuses + unknown fallback.
- `authentication_required` shows token step; `connected` skips token.

### Component

- Pending probe shows **Connecting** copy (i18n), not a fake `probeStatus`.
- Token re-probe pending shows **Verifying**.
- `branchesTruncated: true` renders truncation notice (frontend §98).
- Self-hosted: token link href uses `{baseUrl}/-/user_settings/personal_access_tokens`.
- Attach success closes dialog and invalidates project query.
- Attach failure: `role="alert"` with API message.
- Token value never appears in DOM after successful attach (query snapshot).

### Unhappy paths

- `429`: show backend message only — no invented rate-limit policy copy.
- Malformed URL: `400` before pending state stuck.
- `403` on probe: forbidden state.

## 10. Definition of Done

- [ ] No provider picker; URL-only first step.
- [ ] Probe uses Phase 30 endpoint; attach uses Phase 31 endpoint when backend exists.
- [ ] Connecting / Verifying are client pending states only.
- [ ] Token never displayed after submit; credential fields write-only.
- [ ] Token scope instructions cite open question — no unapproved scope mandate in i18n.
- [ ] No `useAppData` / mock probe in `ConnectRepositoryDialog`.
- [ ] i18n complete; action feedback on all primary actions.
- [ ] Responsive 375 / 768 / 1280; tests ≥ 80% line and branch on touched files.

## 11. Documentation & ADR updates

- None unless attach idempotency pattern is shared with upload — note in Phase 13 client doc.
- Cite Phase 30 §12 in PR description when scope copy is blocked on product answer.

## 12. Risks & open questions

Ask the user; do not assume.

1. **Token scopes (Phase 30 §12 Q3).** Which scope strings appear in inline help — `repo` /
   `api` as requirements examples, or narrower backend §19 scopes?
2. **Token handoff (Phase 30 §12 Q4).** Resend token on attach vs one-time probe handle — affects
   whether token stays in dialog memory through confirm step only or crosses one wire.
3. **Probe HTTP status (Phase 30 §12 Q1).** UI error handling must match approved pattern (`200`
   body vs HTTP errors).
4. **Attach path and idempotency (Phase 31).** Exact paths, headers, and duplicate-connect
   behavior (one connection per project vs many — missing plan question 11).
5. **Post-attach messaging.** Attach does not download sources (Phase 32). What should confirm
   step promise — “connection saved” vs “sync started”?
6. **GitHub Enterprise / Bitbucket.** Out of scope per Phase 30 — confirm error copy for
   unsupported hosts.
7. **Self-hosted TLS (Phase 30 §12 Q7).** Private CA instances may fail probe — UI copy only,
   no client cert UI unless backend adds config.
