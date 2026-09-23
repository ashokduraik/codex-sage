# Phase 36 — Frontend sources & project health slice

- **Layer:** FE
- **Depends on:** Phase 19 (frontend projects slice), Phase 28 (knowledge publish & health),
  Phase 31 (repository attach & credentials)
- **Unblocks:** — (README); Phase 40 still owns knowledge explorer tree
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §29 (knowledge completion CTAs where
  applicable on Sources/Health), §30 (overview health slice only — not capability tree),
  §74 (knowledge health view), §81A (project sources), §89–§90; `backend/requirments.md` §26–§30,
  §112; decision **D7**

## 1. Goal

After this phase `SourcesPanel` and `HealthPanel` show backend-backed source connections,
upload/version history, exclusion callouts, and knowledge health — without `mockProject` bridge
fields or mock audit/token simulation. Health uses authoritative `knowledgeHealth` and project
`counts` from the API (Phase 19 mapping); it does **not** fabricate a knowledge tree or browse
API nodes (Phase 40).

You can see it working on a project with a connected repo: Sources shows URL, branch,
connection status, version rows with links to job details; Health shows badges and simple checks
derived from API fields (e.g. excluded file count), with partial-map warning when counts indicate
exclusions — not from mock `knowledgeTree`.

## 2. Why this phase is here

Phases 24 and 31 create sources and connections; Phase 28 sets `knowledgeHealth` and publish
semantics. Phase 19 intentionally left Sources, Health, and overview capability sections on mocks
(`mockProject` outlet). This slice completes the project shell for ingest observability before
Phase 40 replaces the knowledge explorer.

It must not precede read APIs for source versions and repository connection (§6 — some **PROPOSED**
and may need a small backend addition). It must not implement knowledge browse (Phase 37) or
explorer UI (Phase 40).

## 3. Scope

### In scope

- API modules for source version list and repository connection read/manage endpoints (Phase 31
  **PROPOSED** + list endpoint **PROPOSED** — §6).
- React Query hooks used by `SourcesPanel.jsx` and `HealthPanel.jsx`.
- Rewire Sources: origin upload vs repository, branch, timestamps, link to processing/job detail
  (Phase 35 routes), credential replace/revoke/re-test using shared probe/attach hooks from
  Phase 34 where applicable (§14A).
- Rewire Health: `KnowledgeHealthBadge` / lifecycle from `projectStatusMap.js`; checks limited to
  fields the backend actually returns (source present, excluded counts, health enum) — **no**
  `knowledgeTree` length checks.
- Remove `mockProject` usage from Sources and Health; shrink `buildMockProjectBridge` usage in
  outlet context for these tabs only.
- Delete or stop exporting mock-only `KnowledgeStatusBadge` string badges when Health migrates
  (Phase 19 noted removal here).
- i18n, loading/error/empty states, responsive layout, colocated tests.

### Out of scope (owner phase)

- Knowledge explorer, search, capability tree on overview — **Phase 40** (frontend §30 bulk).
- Change summary panel — **Phase 39/40**.
- Manual repository sync trigger — **Phase 32** (optional button only if API exists).
- Live DB / data knowledge rows — **README §5**.
- Hard delete / purge sources — retention **Phase 60**.

## 4. Design

### 4.1 Feature layout

```text
frontend/src/features/projects/
  api/sourcesApi.js            extend Phase 33 with list/get if approved
  api/repositoriesApi.js       extend Phase 34 with GET/PATCH/replace/revoke
  hooks/useSourceVersions.js   paginated list for project
  hooks/useRepositoryConnection.js
  hooks/useRepositoryCredentialActions.js   replace/revoke mutations
  SourcesPanel.jsx             real data + upload/connect dialogs (33/34)
  HealthPanel.jsx              API-driven checks
  HealthPanel.test.jsx / SourcesPanel.test.jsx
```

Health data sources:

```text
useProject(projectId)     → knowledgeHealth, lifecycleStatus, counts.*
useRepositoryConnection   → connectionStatus, branch, repo identity (no token)
useSourceVersions         → version rows, fileCounts, linked jobId
```

### 4.2 Sources panel (frontend §81A)

Display when backend provides:

| Row | Source |
|---|---|
| Origin upload vs repository | `sourceVersions[].origin` or connection record |
| Repository full name + URL | Phase 31 connection DTO |
| Selected branch | connection `branch` |
| Version history | list endpoint §6 |
| Created by / at | version `createdBy`, `createdAt` |
| Processing result | link to `GET /jobs/:jobId` summary or navigate to Processing center |
| Exclusions | `fileCounts.excludedFromGraph`, `skipped` — no invented paths list unless API adds |
| Credential actions | replace/revoke/re-test — write-only token fields |

Additional upload opens Phase 33 dialog; connect opens Phase 34. Copy frames as “update project
knowledge” (frontend §15, §81A).

### 4.3 Health panel (frontend §74)

Simple checks only:

- **Source connected** — connection exists or `counts.sourceVersions > 0`.
- **Knowledge health** — `KnowledgeHealthBadge` on `project.knowledgeHealth` (Phase 19 map).
- **Excluded from graph** — when `counts.excludedFiles > 0` (or API field), show partial-map
  attention copy; state Chat may be incomplete per backend §112 / frontend §74 — use
  `isProjectAskable` helper, do not promise full map.
- **Stale / failed** — map enums; unknown → unknown key.

Do **not** show “Documentation Good” based on `knowledgeTree` mock nodes. Do not show Data
database health (frontend §74).

Optional links: Processing center, Chat when askable (§29 CTAs).

### 4.4 Anti-invention rules

- No fabricated health sub-scores (“Documentation Good”) unless backend exposes structured
  health breakdown — Phase 28 may only set project-level `knowledgeHealth` (confirm §12).
- No file-level exclusion list without browse/preview APIs (Phase 39).
- Connection status values must match backend §18 / Phase 31 enum — map in one module.

### 4.5 Outlet context cleanup

`ProjectDetailPage` outlet may pass `project` from `useProject` only for Sources/Health; remove
`mockProject` fallback in these panels. Other tabs (Changes, Chat) keep mock until their phases.

### 4.6 Action feedback & errors

Replace/revoke/re-test: same loader/`aria-busy`/`role="alert"` pattern. Never show stored token.
Re-test uses probe mutation (Phase 34), not client simulation (`SourcesPanel` today uses fake
timeout).

## 5. Data model changes

**None** (frontend).

## 6. API contract — implemented

Frontend consumes the shipped Phase 24/31 surfaces plus the source-versions list added here.

### Already defined elsewhere

| Endpoint | Owner phase | Use in this slice |
|---|---|---|
| `GET /api/v1/projects/:projectId` | Phase 17 | Health badges, counts |
| `POST .../sources` | Phase 24 | Upload entry (Phase 33) |
| `GET /api/v1/jobs/:jobId` | Phase 20/22 | Version → job detail link |
| Probe / attach | Phase 30/31 | Connect + re-test |

### `GET /api/v1/projects/:projectId/source-versions?cursor&limit` — **implemented**

- **Permission:** `projects.view` (there is no `sources.view`).
- **Response `200`:**

```json
{
  "items": [{
    "id": "665a00000000000000000001",
    "origin": "upload",
    "versionLifecycle": "accepted",
    "fileCounts": { "accepted": 4812, "skipped": 1203, "excludedFromGraph": 9 },
    "jobId": "665f1c9d4b2a8e0012a4f001",
    "commitSha": null,
    "branch": null,
    "createdBy": "6650f0aa0000000000000001",
    "createdAt": "2026-09-11T09:12:04.000Z"
  }],
  "pageInfo": { "nextCursor": null, "hasMore": false }
}
```

### Repository connection (Phase 31 — **implemented**)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/projects/:projectId/repositories/connection` | Sources header metadata |
| `PATCH` | `.../connection/branch` | Branch change |
| `POST` | `.../credentials/replace` | Replace credential (body token only) |
| `POST` | `.../credentials/revoke` | Disconnect / revoke |
| `POST` | `.../connection/re-test` | Re-test stored credentials |

Response includes `connectionStatus`, `repository` identity, `selectedBranch`, `provider`,
`baseUrl`, and `lastSyncedAt` when present. Do not invent `lastSyncAt` / `nextSyncAt`.

## 7. Configuration & environment variables

**None.**

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/projects/api/sourcesApi.js` | **Extend:** list source versions |
| `frontend/src/features/projects/api/repositoriesApi.js` | **Extend:** GET/PATCH/replace/revoke |
| `frontend/src/features/projects/hooks/useSourceVersions.js` | **New** |
| `frontend/src/features/projects/hooks/useRepositoryConnection.js` | **New** |
| `frontend/src/features/projects/hooks/useRepositoryCredentialActions.js` | **New** |
| `frontend/src/features/projects/hooks/*.test.jsx` | **New** |
| `frontend/src/features/projects/SourcesPanel.jsx` | Remove useAppData mock retest/audit |
| `frontend/src/features/projects/SourcesPanel.test.jsx` | API-backed cases |
| `frontend/src/features/projects/HealthPanel.jsx` | Remove knowledgeTree checks |
| `frontend/src/features/projects/HealthPanel.test.jsx` | Badge + exclusion copy |
| `frontend/src/features/projects/ProjectDetailPage.jsx` | Outlet: drop mockProject for migrated tabs |
| `frontend/src/features/projects/buildMockProjectBridge.js` | Shrink or document remaining consumers |
| `frontend/src/shared/components/StatusBadge.jsx` | Remove mock string badges if unused |
| `frontend/src/shared/i18n/locales/en.json` | Sources/health strings |

Phase 33/34 files unchanged except shared API extensions.

## 9. Tests (≥ 80% line and branch)

### Unit

- Health checks derive from fixture project `counts` — failing when excludedFiles > 0 message shown.
- Connection status map unknown code → neutral label.

### Component

- Sources: upload + connect buttons open dialogs; version row links to job route.
- Replace credential: token field cleared on close; success invalidates connection query.
- Health: renders `KnowledgeHealthBadge` from API code, not display string.
- Loading skeletons; empty source list; API error with retry.
- 375 px: Sources rows stack without horizontal scroll.

### Unhappy paths

- Revoke forbidden `403`.
- List endpoint missing in dev — feature flag or graceful “not available” **only if** product
  agrees; prefer blocking phase until API exists.

## 10. Definition of Done

- [x] `SourcesPanel` and `HealthPanel` do not import `useAppData` or `mockProject`.
- [x] Health uses backend `knowledgeHealth` + counts only — no knowledge explorer (Phase 40).
- [x] Sources show connection + versions from approved list/GET APIs.
- [x] Credential UI write-only; re-test uses real probe.
- [x] i18n complete; loading/error/empty per §89–§90.
- [ ] Responsive 375 / 768 / 1280; ≥ 80% coverage on touched files.

## 11. Documentation & ADR updates

- When source-versions list is approved, update `docs/data-model.md` consumer note or Phase 24
  cross-link — do not duplicate schema.
- README §3 frontend state note when revised: Sources/Health off mocks.

## 12. Risks & open questions

Ask the user; do not assume.

1. **Source version list endpoint.** Phase 24 has POST only. Approve §6 list route (and permission)
   before Phase 36 implementation, or defer Sources history UI.
2. **Phase 31 document availability.** Attach/read/revoke paths and enums must match approved
   Phase 31 §6 — this plan cites Part G summaries until file exists.
3. **knowledgeHealth enum mapping (Phase 28 / missing plan Q5).** Health copy must match backend
   (`partial` vs `partially_available`, lifecycle vs health).
4. **Structured health breakdown (frontend §74 example).** If backend only exposes single enum,
   UI stays single badge + short explanation — confirm no sub-scores in MVP.
5. **Exclusion detail depth.** Counts only vs link to future preview API (Phase 39).
6. **Sync metadata on Sources.** Show `lastSyncAt` / manual sync when Phase 32 ships — optional
   follow-up in same phase or tiny add-on PR.
7. **Remove `KnowledgeStatusBadge`.** Confirm no remaining imports after Health migration.
8. **mockProject bridge.** Which panels still need it after this phase (Changes, Chat) — document
   in `ProjectDetailPage` comment for later phases.
