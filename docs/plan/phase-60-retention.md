# Phase 60 — Retention policies & scheduled cleanup

- **Layer:** BE+FE
- **Depends on:** Phase 10 (audit append-only + retention hook flag), Phase 13 (FE client),
  Phase 21 (`scheduledAt` scheduler), Phase 41 (conversation soft-delete semantics)
- **Unblocks:** Phase 61 (security pass verifies retention queries scope `orgId`), Phase 62
- **Size:** 1–2 days
- **Requirements covered:** backend/requirments.md §101–103, §102; frontend/requirments.md §86A;
  backend/solution.md §12.3, §9.1; docs/architecture.md §10

## 1. Goal

After this phase a **scheduled worker job** enforces organization retention defaults: keep the last
**three** ready source versions (older versions soft-deleted then eligible for orphan marking),
conversation history past **365** days inactive archived path soft-deleted, job history **180**
days, audit **730** days soft-delete only, notifications **90** days (or **30** days after read
when implemented), usage rollups **730** days. Project delete cascades **soft-delete** to sources,
knowledge, conversations, and jobs per policy while **audit rows remain** until their own retention
window. You can see it working by seeding backdated rows in a test org, running the retention
handler, and observing `status: 'D'` on targeted documents without hard `DELETE` from client APIs
and without GridFS byte purge until a future ADR enables it.

## 2. Why this phase is here

Solution §12.3 and backend §101–102 require explicit lifecycle for enterprise data, but phases
10–41 create growing collections with no expiry. Phase 21 already provides **`scheduledAt`**
scheduling shared with repo sync (32); retention must reuse that mechanism rather than a cron
outside the worker. Phase 10 pre-hooks allow retention updates only with `{ retentionJob: true }`.
Frontend §86A applies **only if** this phase exposes writable org policy — otherwise admins see
defaults in docs only (§12). Hard GridFS purge is explicitly deferred (plan Q14).

## 3. Scope

### In scope

- **`retention` worker job type** registered on phase 21 registry; periodic `scheduledAt` tick
  (interval as named constant, e.g. daily UTC).
- **Default policy document** per organization (embedded on `organizations` or
  `organizationRetentionPolicies` collection) seeded with solution §12.3 table at org create.
- Enforcement actions — **soft-delete** (`status: 'D'`) unless noted:
  - Source/knowledge: retain last **3** `SourceVersion` / linked `KnowledgeVersion` with ready
    health; older active versions soft-deleted; `SourceFile` rows follow version.
  - Conversations: archived + inactive longer than **365** days → soft-delete messages +
    conversation.
  - Jobs / job events: **180** days → soft-delete (terminal jobs only — **ask §12** whether
    running jobs exempt).
  - Audit: **730** days → soft-delete via retention flag on repository update.
  - Notifications: **90** days or **30** days after `readAt` — **ask §12** which rule wins when
    both apply.
  - Usage: rollup rows **730** days; events if stored separately same window.
- **Project delete cascade:** when project `status` → `'D'`, schedule or immediate cascade
  soft-delete children (sources, knowledge versions, conversations, jobs, notifications) per org
  policy; **do not** hard-delete audit (backend §102).
- **GridFS:** mark orphaned objects per phase 25/60 plan; **no hard purge** in this phase.
- Optional **read API** for current effective policy; optional **PATCH** for org admins —
  **§12 decides** MVP defaults-only vs writable.
- Frontend retention settings page **only if** PATCH exists (frontend §86A).

### Out of scope (owner phase)

- **Hard GridFS purge** and permanent blob removal — requires ADR (plan Q14); document as open.
- Backup/restore product (backend §103) — operational, not this job.
- Legal hold / e-discovery export.
- Cross-org retention (always per `orgId`).
- Customer-database query history retention (later slice).

## 4. Design

### 4.1 Scheduler integration

```text
Phase 21 claim loop
  → jobType: retention
  → handler: runRetentionForOrg(orgId) | runRetentionAllOrgs(batch)
  → reschedule: scheduledAt = nextUtcMidnight + RETENTION_RUN_OFFSET_MS
```

A single global retention job may iterate orgs in batches to avoid long leases; or one job per org
— **ask §12**. Handler must heartbeat on large orgs (phase 21 lease).

### 4.2 Policy defaults (solution §12.3)

| Domain | MVP default | Action after expiry |
|--------|-------------|---------------------|
| Source bytes (old versions) | keep last **3** ready | Soft-delete version + files; orphan GridFS refs |
| Knowledge versions | tied to retained sources | Soft-delete |
| Conversations | **365** d inactive archived | Soft-delete |
| Job / processing history | **180** d | Soft-delete |
| Audit events | **730** d | Soft-delete via retention hook |
| Notifications | **90** d or 30 d after read | Soft-delete |
| Usage rollups | **730** d | Soft-delete or hard-delete rollups only (aggregates) |

Constants live in `retention.defaults.js`; org document overrides when writable policy approved.

### 4.3 Source version retention algorithm

For each project with `status: 'A'`:

1. List `SourceVersion` with `status: 'A'` and published/ready linkage (phase 28 health).
2. Sort by ready timestamp descending.
3. Keep top **3**; for each older version, set `status: 'D'`, soft-delete related
   `SourceFile`, `KnowledgeVersion`, `DocumentSection` rows.
4. Invoke GridFS orphan marker (not purge) for files no longer referenced by active versions.

Idempotent: re-run does not flip `'D'` rows again.

### 4.4 Project delete cascade

On project soft-delete (phase 17):

```text
project.status = 'D'
  → enqueue retention.cascadeProject(projectId) OR inline cascade in delete handler
  → soft-delete: sourceVersions, knowledgeVersions, conversations, messages, jobs, notifications
  → skip: audit (remain until audit retention age)
```

Audit entries referencing the project stay queryable for admins until §730d retention.

### 4.5 Audit retention

Use repository method `softDeleteAuditEventsBefore(cutoff, { retentionJob: true })` so Mongoose
hooks allow update (phase 10 design). Never expose delete API to clients.

### 4.6 Frontend (conditional)

If `GET/PATCH /api/v1/organizations/retention-policy` (PROPOSED) ships:

- Simple form: numeric days / version count with validation bounds.
- Plain-language explainer (frontend §86A).
- If API is read-only defaults, **no FE settings page** — only docs.

## 5. Data model changes

**Policy storage (PROPOSED one of):**

- Embedded `retentionPolicy` on `organizations` document, or
- `organizationRetentionPolicies` `{ orgId, policy, status: 'A'|'D' }`.

Policy fields mirror §4.2 defaults with optional overrides.

**No new row `status` on unrelated collections** — use existing `status: 'D'`.

Optional: `retentionRuns` log `{ orgId, startedAt, counts, status }` for ops — **ask §12**.

## 6. API contract — PROPOSED (needs approval before implementation)

### `GET /api/v1/organizations/retention-policy`

- **Permission:** `settings.manage` or `org.manage`
- **Response:** effective policy object with defaults filled in.

### `PATCH /api/v1/organizations/retention-policy`

- **Only if §12 chooses writable MVP**
- **Permission:** `settings.manage`
- **Body:** subset of policy fields within safe min/max constants.
- **Audit:** `retention.policy_changed` via phase 10 writer (counts only, no secrets).

If defaults-only MVP: **no PATCH**; section documents GET optional for transparency.

## 7. Configuration & environment variables

**None.** Retention run interval, batch size, and policy min/max bounds are named constants in
`retention.constants.js`. Worker uses phase 21 poll/lease env from phase 01 only.

## 8. Files to create or change

| Path | Purpose |
|------|---------|
| `backend/src/modules/retention/index.js` | Public surface + handler registration |
| `backend/src/modules/retention/retention.handler.js` | Scheduled job entry |
| `backend/src/modules/retention/retention.defaults.js` | Solution §12.3 defaults |
| `backend/src/modules/retention/retention.service.js` | Per-domain enforcement |
| `backend/src/modules/retention/retention.repository.js` | Batch updates with `{ retentionJob: true }` |
| `backend/src/modules/retention/retention.routes.js` | Optional GET/PATCH policy |
| `backend/src/modules/retention/policies/sourceVersions.js` | Keep-last-3 logic |
| `backend/src/modules/retention/policies/conversations.js` | 365d rule |
| `backend/src/modules/retention/policies/jobs.js` | 180d rule |
| `backend/src/modules/retention/policies/audit.js` | 730d soft-delete |
| `backend/src/modules/retention/policies/notifications.js` | 90d / read rule |
| `backend/src/modules/retention/policies/usage.js` | Rollup expiry |
| `backend/src/modules/retention/projectCascade.js` | Delete cascade |
| `backend/src/modules/retention/*.test.js` | Tests |
| `backend/src/worker/index.js` | Register retention handler |
| `backend/src/modules/projects/projects.service.js` | **Change:** invoke cascade on delete |
| `backend/src/modules/audit/audit.repository.js` | **Change:** retention-scoped soft delete |
| `frontend/src/features/settings/RetentionSettingsPage.jsx` | **If** PATCH approved |
| `frontend/src/features/settings/hooks/useRetentionPolicy.js` | React Query |
| `frontend/src/i18n/locales/en/retention.json` | Strings |

## 9. Tests (≥ 80% line and branch)

### Backend

- Keep-last-3: four ready versions → oldest soft-deleted; three remain `A`.
- Conversation past cutoff archived → `D`; active unarchived untouched.
- Audit before cutoff → `D` with retention flag; audit API list excludes them (phase 10).
- Project delete → children `D`, audit rows still `A`.
- Retention job respects `orgId` — no cross-tenant updates.
- Re-run idempotent.
- GridFS: orphan marker called; assert no hard delete helper invoked.

### Frontend (if settings UI in scope)

- Form loads GET policy; PATCH mutation success/error.
- If no PATCH API, confirm route absent from nav (snapshot test).

## 10. Definition of Done

- [ ] Retention handler registered; runs via `scheduledAt` without blocking HTTP.
- [ ] All §12.3 defaults enforced in tests with backdated fixtures.
- [ ] Soft-delete only for user-visible data; audit uses retention hook.
- [ ] Project delete cascade soft-deletes dependents; audit retained until audit retention.
- [ ] GridFS hard purge not implemented; ADR gap noted in §12.
- [ ] FE settings only when writable API approved.
- [ ] Coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- Record **ADR for hard GridFS purge** before any purge code (plan Q14) — this phase may add
  stub `docs/adr/TBD-gridfs-purge.md` placeholder only if product requests; otherwise §12 reference.
- `docs/data-model.md`: policy storage.
- `backend/solution.md` §12.3 remains authoritative for default numbers.

## 12. Risks & open questions

1. **Writable policy vs defaults-only (FE §86A):** Does MVP expose `PATCH` retention policy or
   enforce constants only with no admin UI?
2. **Hard GridFS purge (plan Q14):** When should ADR be written relative to soft-delete of versions?
3. **One global retention job vs per-org jobs?**
4. **Notifications:** 90 days from `createdAt` vs 30 days after `readAt` — precedence?
5. **Running/failed jobs:** Are non-terminal jobs exempt from 180d rule?
6. **“Ready” for keep-3:** Count only `knowledgeHealth` ready/partial published versions?
7. **Usage events vs rollups:** Does retention hard-delete rollup docs but soft-delete events?

### Appendix — collection touch list

Each retention sub-policy must only update rows matching `{ orgId, status: 'A' }` unless
setting `status: 'D'`.

| Collection | Retention policy | Hook / flag |
|------------|------------------|-------------|
| `sourceVersions` | keep last 3 ready | standard soft-delete |
| `sourceFiles` | follow version | standard soft-delete |
| `knowledgeVersions` | follow source | standard soft-delete |
| `documentSections` | follow source | standard soft-delete |
| `conversations`, `messages` | 365d archived inactive | standard soft-delete |
| `jobs`, `jobEvents` | 180d terminal | standard soft-delete |
| `auditEvents` | 730d | `{ retentionJob: true }` only |
| `notifications` | 90d / read rule | standard soft-delete |
| `usageEvents`, `usageRollups` | 730d | per phase 59 storage |
| `projects` | cascade on delete | trigger from phase 17 |

GridFS: after version soft-delete, run orphan detection; **do not** call delete on buckets until
ADR approves purge semantics and backup posture.

### Appendix — interaction with phase 58–59

Notifications and usage written by phases 58–59 are subject to this job’s cutoffs. Emitters do
not self-delete; retention is the sole automated expiry path besides manual org offboarding (out
of scope).
