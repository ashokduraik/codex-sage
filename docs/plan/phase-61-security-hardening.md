# Phase 61 — Security & tenant-isolation hardening pass

- **Layer:** BE
- **Depends on:** Phase 12 (idempotency; **no** in-app rate limits), Phase 18 (project ACL +
  guard checklist), Phase 28 (knowledge gate), Phase 50 (chat SSE boundary)
- **Unblocks:** Phase 62 (observability builds on safe logging baseline), Phase 63 (security
  integration tests in CI)
- **Size:** 1–2 days
- **Requirements covered:** backend/requirments.md §16, §88–§90, §114, §115, §147–§150;
  frontend/requirments.md §107 (verification notes for parent FE pass); backend/solution.md §13.1;
  docs/adr/0014-cross-tenant-404.md, docs/adr/0016-audit-write-best-effort.md; docs/architecture.md §10

## 1. Goal

After this phase the backend has a **documented hardening pass**, not new product features: every
protected route declares **`requiredPermissions`** or **`requireProjectPermission`**, every
repository query filters **`orgId`** and **`status: 'A'`** (and project scope where applicable),
forged cross-tenant or cross-project ids return **`404 NOT_FOUND`** per ADR 0014, path traversal
and workspace/preview escapes are rejected, and logs/errors/audit/chat payloads are reviewed so
secrets and full source bodies do not leak (backend §148–§149). Integration tests prove forged ids
on knowledge, chat, search, preview, and repository routes fail closed. **In-app rate limiting is
not added** (solution §13.1, phase 12). You can see it working when the hardening checklist is
complete, CI runs the forgery suite green, and a manual spot-check shows identical 404 bodies for
missing vs other-tenant ids.

## 2. Why this phase is here

Phases 17–57 add many routes quickly; requirements §89–§90 demand defense in depth independent of
UI. A dedicated pass after chat (50) and knowledge (28–40) catches gaps before observability (62)
and E2E (63). It depends on Phase 18’s checklist so project-scoped permissions are the pattern,
and Phase 12 so engineers do not “fix abuse” by adding `@fastify/rate-limit` inside Node. Frontend
§107 is satisfied by backend not emitting secrets; optional FE audit is noted in §11, not implemented
here (BE layer).

## 3. Scope

### In scope

- **Route audit:** inventory all registered routes; each must have explicit auth config (phase 09)
  and project routes must use `requireProjectPermission` per `phase-18-guard-checklist.md`.
- **Repository audit:** spot-check and fix modules for missing `orgId`, missing `status: 'A'`,
  or accepting `projectId` from body without membership check.
- **Cross-tenant / cross-project tests:** forged ObjectIds on:
  - Knowledge browse (37), search (38), preview (39)
  - Conversations and chat SSE (41, 50)
  - Repository attach/sync (30–32)
- **Path safety:** workspace materialization roots (26), preview path params (39), zip paths (23)
  — reject `..`, absolute paths, null bytes (backend §16).
- **Secret hygiene pass:** error handler, stream errors, audit sanitizer (10), chat persist (49),
  notification/usage modules (58–59) — no tokens in outbound JSON or structured logs.
- **ADR 0014 enforcement:** handlers return 404 for wrong org resource; 403 only for same-org
  permission denial.
- **Documentation:** `docs/plan/phase-61-security-checklist.md` or section in this file’s DoD
  listing each route verified (can be appendix in repo docs folder).
- **No new features:** no new endpoints except test hooks if already pattern in harness.

### Out of scope (owner phase)

- **In-app rate limiting** — explicitly forbidden (solution §13.1, phase 12, architecture §10).
- WAF / LB configuration (ops).
- Penetration test vendor engagement.
- FE visual secret scan — owners may run manual pass against §107; no FE code required in this
  phase file unless parent agent expands scope.
- New RBAC permissions or role redesign.
- Encryption at rest ADR for workspace (phase 26 open question).

## 4. Design

### 4.1 Hardening workflow

```text
1. Generate route inventory from Fastify route table (script or test snapshot).
2. Compare to phase-18 checklist + README phase index routes.
3. For each gap: add config.requiredPermissions / requireProjectPermission.
4. For each * repository: grep for find without orgId + status.
5. Add integration tests: principal org A, resource org B → 404 same body as missing.
6. Run log redaction spot-check on chat + ingest failure fixtures.
```

### 4.2 Test matrix (forged id pattern)

Each test uses two orgs with users, a resource in org B, caller in org A with valid JWT for A.

| Area | Example route | Expected |
|------|---------------|----------|
| Knowledge | `GET /projects/:projectId/knowledge/summary` | 404, `NOT_FOUND` |
| Search | `GET /projects/:projectId/search?q=test` | 404 |
| Preview | `GET /projects/:projectId/files/slice?path=...` | 404 |
| Chat | `POST /conversations/:id/messages` (conv in B) | 404 |
| Repo | `POST /projects/:projectId/repositories/sync` (project B) | 404 |

Same-org lacking permission → **403 FORBIDDEN** (distinct test).

### 4.3 Query guard template

Repositories must accept `(orgId, projectId, ...)` from resolved scope, never raw from unvalidated
body alone:

```js
// Pattern enforced in review (illustrative)
await Model.findOne({
  _id: resourceId,
  orgId: scope.orgId,
  projectId: scope.projectId,
  status: 'A',
});
```

Chat messages: resolve conversation under org + project ACL before SSE (phase 50).

### 4.4 Path traversal

- Preview and file APIs normalize path with same helper as phase 23 `pathSafety`.
- Workspace reads join under `WORKSPACE_ROOT/{orgId}/{projectId}/` with boundary check.
- Failure → `400` or `404` without revealing whether path existed elsewhere.

### 4.5 Logging and errors

- Confirm global error handler strips `err.stack` from client JSON (phase 02).
- SSE `error` events use catalog messages only (phase 50).
- Audit: phase 10 sanitizer tests still pass; add cases if new modules log context.
- ADR 0016: audit failures still do not throw; no change unless bug found.

### 4.6 Rate limiting posture

Document in module README or `backend/solution.md` pointer: **no** `@fastify/rate-limit`.
`RATE_LIMITED` catalog entry remains for upstream 429 mapping only. Review PR template reminder.

### 4.7 Project-scoped answers (§114–§115)

Chat and search tests: question in project A must not retrieve embeddings/files from project B even
if ids are guessed — enforced at tool layer (46) and API scope; hardening adds regression tests
at HTTP boundary.

## 5. Data model changes

**None.** This phase changes guards and tests, not schemas.

## 6. API contract — PROPOSED (needs approval before implementation)

**No new public APIs.** Existing routes may gain stricter validation (same paths/status codes).

PROPOSED **test-only** endpoint is **out of scope** — use harness helpers to seed cross-tenant
fixtures.

Document expected behavior:

| Situation | HTTP | Code |
|-----------|------|------|
| Resource id not found | 404 | `NOT_FOUND` |
| Resource in other org | 404 | `NOT_FOUND` (ADR 0014) |
| Same org, no permission | 403 | `FORBIDDEN` |
| Invalid path param | 400 | validation catalog |

## 7. Configuration & environment variables

**None.**

## 8. Files to create or change

| Path | Purpose |
|------|---------|
| `backend/src/test/integration/security/crossTenantForgery.test.js` | **New:** ADR 0014 suite |
| `backend/src/test/integration/security/pathTraversal.test.js` | **New:** preview/workspace |
| `backend/src/test/integration/security/projectScopeChat.test.js` | **New:** chat/search isolation |
| `backend/src/test/helpers/twoOrgFixture.js` | **New:** shared seed |
| `backend/src/modules/*/routes.js` | **Change:** permission gaps only |
| `backend/src/modules/*/repository.js` | **Change:** org/status filters |
| `docs/plan/phase-18-guard-checklist.md` | **Change:** mark routes verified |
| `backend/scripts/list-routes.js` | **Optional:** inventory aid |
| `AGENTS.md` or `backend/README.md` | **Change:** pointer to hardening complete |

No frontend files required (layer BE); parent may track FE §107 separately.

## 9. Tests (≥ 80% line and branch)

### Integration (primary deliverable)

- For each row in §4.2: cross-tenant → 404; assert response body matches genuine missing id
  (snapshot or deep equal on `error.code` + message class).
- Same-org viewer without `chat.ask` → 403 on message POST.
- Preview `path=../../../etc/passwd` → rejected.
- Repository sync with other org’s `projectId` → 404.

### Unit

- Path normalizer rejects `..`, `\`, absolute prefixes.
- Any new guard helpers reach 80% if extracted.

### Regression

- Existing module tests still pass; no broad mocks that hide missing `orgId`.

## 10. Definition of Done

- [ ] Route inventory complete; zero authenticated routes without explicit permission config.
- [ ] Phase 18 checklist updated with all implemented phases marked verified.
- [ ] Cross-tenant forgery suite covers knowledge, search, preview, chat, repo.
- [ ] Path traversal tests for preview/workspace helpers.
- [ ] No `@fastify/rate-limit` or in-process rate limit middleware added.
- [ ] Manual review checklist for §148 (no secrets in errors/logs/audit) signed off in PR.
- [ ] `npm run lint`, `npm test` green; new tests maintain ≥ 80% on touched guard code.

## 11. Documentation & ADR updates

- Confirm ADR 0014 and 0016 still accurate; amend only if implementation diverged.
- `docs/architecture.md` §10: rate limit row unchanged (not in Node API).
- Optional short `docs/security/hardening-pass.md` summarizing verified areas (if team wants
  external audit trail) — only if user approves extra doc file.

Frontend §107: record in PR that API payloads for notifications, audit, chat were spot-checked;
no credential fields in JSON samples.

## 12. Risks & open questions

1. **Route inventory drift:** Should CI fail if a new route merges without permission metadata
   (lint rule vs test snapshot)?
2. **404 vs 403 on project membership:** User in org but not project member — 404 or 403?
   Align with phase 18 resolver behavior and document once.
3. **Search/knowledge during `updating`:** Forgery tests use stable resources; gate errors are
   separate from tenant tests — confirm matrix includes unavailable codes where ids valid.
4. **Log sampling:** Automated scan for `Authorization` header in logs or manual only?
5. **Org path parameters:** Any route still accepting `:orgId` in URL that differs from JWT —
   must be removed or validated (404 on mismatch).

### Appendix — route phases to verify (from README index)

Phases **17–18** projects; **23–24** upload; **30–32** repository; **37–39** knowledge/preview;
**41–42** conversations; **50–53** chat/clarify/edit; **58–59** notifications/usage; **60**
retention policy if exposed. Admin routes **10–11** already org-scoped.

For each `:projectId` route, confirm `preHandler: requireProjectPermission(...)` matches
solution §8.2 permission for that operation. Org-only routes use `requiredPermissions` on route
config without trusting `:projectId` from URL for tenant scope when only org-level resource exists.

### Appendix — secret patterns to grep in tests

Automated or manual grep for forbidden substrings in **test HTTP responses** (not production logs):

`Bearer `, `ghp_`, `glpat-`, `password`, `privateKey`, `apiKey` in JSON bodies from chat, audit
list, notification list, and error envelopes after simulated failures.

### Appendix — relation to phase 62

Observability (62) adds structured logging fields; this phase ensures those logs still omit
source bodies and tokens before 62 documents field names.

### Appendix — idempotency vs isolation

Phase 12 idempotency keys are scoped `{ orgId, userId, route, key }`. Hardening verifies no
handler uses idempotency lookup to bypass project ACL (replay must still respect current
permissions on the stored resource id).
