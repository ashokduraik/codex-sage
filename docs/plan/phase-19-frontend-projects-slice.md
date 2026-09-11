# Phase 19 — Frontend projects slice

- **Layer:** FE
- **Depends on:** Phase 14 (frontend auth slice), Phase 17 (project model & CRUD), Phase 18
  (project-scoped authorization)
- **Unblocks:** Phase 33, 34, 35, 36, 40, 54 (every project-scoped frontend slice)
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §8 (home dashboard), §9 (project creation
  and lifecycle states), §30 (project overview), §74 (knowledge health), §81 (project
  navigation), §81B (archive and deletion), §88 (empty states), §89 (loading states),
  §90 (error states), §98 (technical realism), §99 (minimal clicks), §105.36;
  `backend/requirments.md` §9, §152 (authoritative state); `backend/solution.md` §8.4

## 1. Goal

After this phase the project screens run on the real backend. `ProjectsPage`,
`ProjectPickerPage`, `CreateProjectDialog`, the `ProjectDetailPage` shell, the identity part of
`ProjectOverview`, and the Home recent-projects and knowledge-status sections read from
`/api/v1/projects` through React Query instead of `useAppData()`.

You can see it working by signing in and creating a project: it appears in the list without a
page reload, its badge shows the backend's `lifecycleStatus`, archiving it removes it from the
default list and from the picker, and deleting it shows consequences fetched from the backend.
Chat, Knowledge, Sources, Changes and Processing still render mock data — they are migrated by
Phases 33–36, 40 and 54.

## 2. Why this phase is here

Phase 14 gave the app a real session, and Phases 17–18 gave it real projects with real access
control. Projects are the entry point to every other screen: the upload slice (33), repository
slice (34), processing slice (35) and chat slices (54–57) all start from a real project id and a
real lifecycle state. Migrating them before the project shell is real would mean writing each of
them twice.

It must not come earlier because there is nothing to fetch, and it must not come later because
every downstream slice would keep inheriting `useAppData()` from the shell.

## 3. Scope

### In scope

- A `projects` API module and React Query hooks for list, detail, create, patch, archive,
  restore, deletion-preview and delete.
- One explicit mapping table from backend `lifecycleStatus` / `knowledgeHealth` codes to badge
  labels and tones, with an unknown-code fallback that invents nothing.
- `ProjectsPage` rewired: server-side search and pagination, archived toggle, skeletons, empty
  and error states.
- `ProjectPickerPage` rewired to the accessible, non-archived project list.
- `CreateProjectDialog` rewired: one step, then hand-off to the upload or repository path.
- `ProjectDetailPage` shell rewired: real project fetch, `404` handling, archive / restore /
  delete actions, archived banner, project-not-askable rule.
- `ProjectOverview`: identity block (name, description, lifecycle badge, knowledge-health badge,
  counts) from the API; the capability/knowledge-tree sections stay on mocks (Phase 40).
- Home dashboard recent-projects and knowledge-status sections from the API.
- New i18n keys for every new string; no literal user-facing text in components.
- Removal of project mock usage from exactly the files above.

### Out of scope (owner phase)

- Upload dialog and upload progress — **Phase 33**.
- Repository connect dialog, branch selection, credential lifecycle — **Phase 34**.
- Processing center, persistent processing indicator, job activity — **Phase 35**.
- `SourcesPanel`, `HealthPanel` — **Phase 36**. `ChangesPanel` — **Phase 39/40**.
- Knowledge explorer, search panel, the knowledge-tree parts of `ProjectOverview` — **Phase 40**.
- Chat workspace and conversations — **Phases 54–57**.
- Deleting `shared/mock-data/` — it goes when the last importer goes (decision D7).
- A project members management screen — no requirement asks for one yet.
- Playwright coverage — **Phase 63** (decision D12).

## 4. Design

### 4.1 Feature layout

```text
frontend/src/features/projects/
  api/projectsApi.ts          request functions over the Phase 13 client
  api/projectTypes.ts         DTO types mirroring Phase 17 section 6
  hooks/useProjects.ts        list query (keyset, search, includeArchived)
  hooks/useProject.ts         detail query
  hooks/useProjectMutations.ts create / patch / archive / restore / delete
  hooks/useProjectDeletionPreview.ts
  projectStatusMap.ts         the single backend-code → badge mapping
  ProjectDeleteDialog.tsx     consequence-explaining delete confirmation
```

The HTTP client, auth header handling and typed error shape come from Phase 13; this phase adds
no second transport. React Query keys:

```text
['projects', 'list', { q, includeArchived }]     infinite query, pageParam = cursor
['projects', 'detail', projectId]
['projects', 'deletionPreview', projectId]
```

Mutations invalidate `['projects', 'list']` and, where relevant,
`['projects', 'detail', projectId]`. No mutation writes cached state by hand except the
optimistic archive toggle described in §4.5.

### 4.2 The status mapping table — the anti-invention rule

The backend is the authority on state (backend §152), and the UI must not invent states
(frontend §9, §98). All translation happens in `projectStatusMap.ts` and nowhere else:

| Backend `lifecycleStatus` | i18n key | Tone |
|---|---|---|
| `creating` | `status.lifecycle.creating` | neutral |
| `awaiting_source` | `status.lifecycle.awaitingSource` | attention |
| `connecting_repository` | `status.lifecycle.connectingRepository` | progress |
| `source_received` | `status.lifecycle.sourceReceived` | progress |
| `processing` | `status.lifecycle.processing` | progress |
| `knowledge_ready` | `status.lifecycle.knowledgeReady` | success |
| `updating` | `status.lifecycle.updating` | progress |
| `failed` | `status.lifecycle.failed` | danger |
| `partially_available` | `status.lifecycle.partiallyAvailable` | attention |
| `archived` | `status.lifecycle.archived` | neutral |

| Backend `knowledgeHealth` | i18n key | Tone |
|---|---|---|
| `none` | `status.knowledgeHealth.none` | neutral |
| `updating` | `status.knowledgeHealth.updating` | progress |
| `ready` | `status.knowledgeHealth.ready` | success |
| `partial` | `status.knowledgeHealth.partial` | attention |
| `stale` | `status.knowledgeHealth.stale` | attention |
| `failed` | `status.knowledgeHealth.failed` | danger |

Rules enforced by tests:

- `knowledge_ready` and `partially_available` render as **different** labels with **different**
  tones (frontend §9: Ready must be distinguishable from Partially available).
- A code the frontend does not know renders `status.lifecycle.unknown` with a neutral tone — it
  is never mapped to the nearest familiar state and never hidden.
- No component contains a string comparison against a lifecycle value except
  `projectStatusMap.ts` and the two rules in §4.5 (`archived`, and the "askable" predicate).
- The predicate `isProjectAskable(project)` lives in the same module: a project is askable only
  when it is not archived and `knowledgeHealth` is `ready` or `partial` (backend §112,
  frontend §81B).

### 4.3 Badge components

`shared/components/StatusBadge.tsx` currently keys its styles on display strings
(`'Knowledge ready'`) produced by the mock data. This phase adds two new exports that take
backend codes — `ProjectLifecycleBadge` and `KnowledgeHealthBadge` — and leaves the existing
`ProjectStatusBadge` / `KnowledgeStatusBadge` untouched so `SourcesPanel`, `HealthPanel`,
`ChangesPanel` and `ChatWorkspace` keep compiling on mock data. The old pair is deleted in
Phase 36 once its last consumer is migrated; that removal is listed in Phase 36's scope.

### 4.4 Creation flow — minimal clicks

Frontend §9 and §99 require *Create Project → Provide Source → Start Understanding* with no
wizard. The dialog keeps its current single step (name, optional description, upload-or-
repository choice) and on submit:

```text
POST /projects { name, description, sourceType }
  → success: invalidate the list, keep the dialog mounted, open the hand-off dialog
             (SourceUploadDialog for 'upload', ConnectRepositoryDialog for 'repository')
             with the real project id
  → the hand-off dialogs are still mock-backed; Phases 33 and 34 replace their internals
  → cancel at the hand-off step: the project stays in 'awaiting_source' /
    'connecting_repository' and is visible in the list with that badge
```

The submit button follows the action-feedback rule: inline spinner, `disabled` and `aria-busy`
while pending, all form controls disabled, and an inline `role="alert"` message sourced from the
API `error.message` (e.g. `PROJECT_NAME_TAKEN`) that clears when the name is edited.

### 4.5 Archive, restore and delete

- **Archive** uses `POST /projects/:id/archive` from the detail-page menu. Archived projects
  disappear from the default list, from `ProjectPickerPage` and from Home; the detail page keeps
  its existing archived banner and the chat entry point is disabled, because an archived project
  is not askable (frontend §81B). The list applies an optimistic update and rolls back on error.
- **Restore** uses `POST /projects/:id/restore` and is only offered from the archived list and
  the archived detail banner.
- **Delete** opens `ProjectDeleteDialog`, which fetches `GET /projects/:id/deletion-preview` and
  renders the backend's `consequences` array plus the returned counts. The consequence text is
  built from i18n keys per `resource` and `effect`; the frontend never hardcodes a count or a
  retention period (frontend §105.37, README §4 "no fabricated metrics"). While the preview is
  loading the confirm button stays disabled; if the preview fails, the dialog shows the error and
  does not offer a blind delete. On success the user is navigated to `/projects` and the list is
  invalidated.

### 4.6 Home dashboard

Frontend §8 asks for *recently accessed* projects. The backend has no access timestamp
(Phase 17 stores `createdAt` / `updatedAt` only), so Home requests the first page of
`GET /projects` ordered by `updatedAt` and labels the section with a key that matches the data
it actually has. Inventing a "recently accessed" ordering from `updatedAt` would be a fabricated
signal — see open question 1. The knowledge-status section uses `knowledgeHealth` from the same
page, so it costs no extra request. Recent conversations and suggested questions stay on mock
data until Phase 54.

### 4.7 Empty, loading and error states

| State | Treatment |
|---|---|
| First load | Skeleton cards matching the final card height, so there is no layout jump (frontend §89) |
| Pagination | The "load more" button shows its own spinner; existing rows stay visible |
| No projects | Existing `EmptyState` with the create action (frontend §88) |
| No archived projects | Existing archived empty copy |
| Detail `404` | The existing "project not found" panel, also used when Phase 18 denies access |
| Query failure | Inline `role="alert"` with `error.message` plus a retry button that calls `refetch` |
| `401` | Handled centrally by Phase 13/14 (session gate, frontend §105.31) — not re-handled here |
| `403` | `errors.forbidden`, with the action control hidden or disabled, never a raw code |
| `429` | `error.message` plus the backend's `retryAfterSec` when present (frontend §105.38) |

When the API error carries a correlation id, it is rendered as a small reference line
(frontend §90).

### 4.8 Responsiveness and accessibility

Cards stay single-column at 375 px, two columns from 768 px, three from 1280 px, using the
existing grid classes. The dialogs are near-full-screen on mobile. Every menu item and dialog is
keyboard reachable, focus returns to the trigger on close, and the delete dialog's destructive
action is not the default focus target.

## 5. Data model changes

**None.** This phase adds no collection and no schema field. It only consumes the collections
created in Phases 17 and 18.

## 6. API contract — PROPOSED (needs approval before implementation)

This phase defines no new backend endpoint; it consumes Phase 17 section 6 unchanged. The
frontend-side contract that needs approval is the **DTO type surface** the hooks expose, because
every later slice imports it:

```json
{
  "id": "6650f1a2c3d4e5f601020304",
  "name": "Atlas Commerce",
  "description": "Checkout and payments",
  "lifecycleStatus": "knowledge_ready",
  "knowledgeHealth": "ready",
  "sourceConfig": { "sourceType": "repository" },
  "counts": { "sourceVersions": 3, "files": 4812, "excludedFiles": 9, "conversations": 12 },
  "archivedAt": null,
  "createdByUserId": "6650f0aa0000000000000001",
  "createdAt": "2026-09-11T09:12:04.000Z",
  "updatedAt": "2026-09-11T09:40:00.000Z"
}
```

List response consumed as:

```json
{ "items": [], "nextCursor": null }
```

Create request sent as:

```json
{ "name": "Atlas Commerce", "description": "Checkout and payments", "sourceType": "upload" }
```

Deletion preview consumed as:

```json
{
  "counts": { "sourceVersions": 3, "files": 4812, "conversations": 12, "jobs": 9 },
  "consequences": [{ "resource": "conversations", "effect": "soft_deleted", "retentionDays": 365 }]
}
```

`lifecycleStatus`, `knowledgeHealth`, `effect` and `resource` are typed as a union of the known
codes **plus** `string`, so an unfamiliar backend value flows into the unknown-code branch of
§4.2 instead of failing a type guard at runtime.

## 7. Configuration & environment variables

**None new.** The API base URL variable is introduced by Phase 13 in `frontend/.env.example`
and mirrored into `frontend/.env` there. If this phase needs any new variable, it must be added
to both files in the same change (`.cursor/rules/env-example-sync.mdc`).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/projects/api/projectsApi.ts` | **New:** request functions for the Phase 17 endpoints |
| `frontend/src/features/projects/api/projectTypes.ts` | **New:** DTO types from section 6 |
| `frontend/src/features/projects/hooks/useProjects.ts` | **New:** infinite list query |
| `frontend/src/features/projects/hooks/useProjects.test.ts` | **New:** paging, search, archived filter |
| `frontend/src/features/projects/hooks/useProject.ts` | **New:** detail query |
| `frontend/src/features/projects/hooks/useProjectMutations.ts` | **New:** create/patch/archive/restore/delete |
| `frontend/src/features/projects/hooks/useProjectMutations.test.ts` | **New:** success, error, invalidation |
| `frontend/src/features/projects/hooks/useProjectDeletionPreview.ts` | **New:** preview query |
| `frontend/src/features/projects/projectStatusMap.ts` | **New:** the single mapping table + `isProjectAskable` |
| `frontend/src/features/projects/projectStatusMap.test.ts` | **New:** every code, unknown fallback, Ready ≠ Partial |
| `frontend/src/features/projects/ProjectDeleteDialog.tsx` | **New:** consequence-explaining confirmation |
| `frontend/src/features/projects/ProjectDeleteDialog.test.tsx` | **New:** loading, error, confirm paths |
| `frontend/src/features/projects/ProjectsPage.tsx` | Replace `useAppData` with `useProjects`; skeletons, error, paging |
| `frontend/src/features/projects/ProjectsPage.test.tsx` | Rewrite against a mocked API client |
| `frontend/src/features/projects/ProjectPickerPage.tsx` | Use `useProjects`, exclude archived |
| `frontend/src/features/projects/ProjectPickerPage.test.tsx` | Update expectations |
| `frontend/src/features/projects/CreateProjectDialog.tsx` | Real `POST /projects` + hand-off |
| `frontend/src/features/projects/CreateProjectDialog.test.tsx` | Pending, error, hand-off assertions |
| `frontend/src/features/projects/ProjectDetailPage.tsx` | Real fetch, archive/restore/delete, outlet context |
| `frontend/src/features/projects/ProjectDetailPage.test.tsx` | `404`, archived banner, menu actions |
| `frontend/src/features/projects/ProjectOverview.tsx` | Identity block from the API; tree still mocked |
| `frontend/src/features/projects/ProjectOverview.test.tsx` | Identity assertions |
| `frontend/src/features/projects/index.ts` | Export the new hooks, map and dialog |
| `frontend/src/features/home/HomePage.tsx` | Recent projects + knowledge status from the API |
| `frontend/src/features/home/HomePage.test.tsx` | Empty, loading, error and populated cases |
| `frontend/src/shared/components/StatusBadge.tsx` | Add `ProjectLifecycleBadge`, `KnowledgeHealthBadge` |
| `frontend/src/shared/components/StatusBadge.test.tsx` | Cover the new badges and the unknown code |
| `frontend/src/shared/components/index.ts` | Export the new badges |
| `frontend/src/shared/i18n/locales/en.json` | Add `status.lifecycle.*`, `status.knowledgeHealth.*`, delete-consequence and error keys |
| `frontend/src/shared/types/domain.ts` | Mark the mock `Project`/`ProjectStatus` types as mock-only |
| `frontend/src/test/renderWithProviders.tsx` | Allow a per-test `QueryClient` and API-client stub |

`frontend/src/shared/mock-data/AppDataContext.tsx` is **not** edited: the provider stays mounted
for the features listed in section 3's out-of-scope block. `ProjectOutletContext` gains a
`mockProject` field for the panels that still need mock fields (`knowledgeTree`, `fileCount`,
`excludedCount`, `source`, `partial`); the field name makes its removal in Phases 33–36 obvious.

## 9. Tests (≥ 80% line and branch)

### Unit

- `projectStatusMap` returns a distinct label and tone for all ten lifecycle codes and all six
  knowledge-health codes.
- `knowledge_ready` and `partially_available` never produce the same label or tone.
- An unknown lifecycle or health code returns the neutral unknown entry.
- `isProjectAskable` is false for archived projects and for `knowledgeHealth` of `none`,
  `updating`, `stale` and `failed`.
- Hooks build the expected query keys and pass `cursor`, `q` and `includeArchived` through.
- Mutation hooks invalidate the list key on success and surface `error.message` on failure.

### Component / integration (Testing Library, mocked API client)

- `ProjectsPage` shows skeletons, then cards; the badge text comes from the mapping table.
- Searching sends `q` to the API instead of filtering locally.
- The archived toggle sends `includeArchived=true` and shows the archived empty state when the
  response is empty.
- "Load more" appears only when `nextCursor` is non-null and appends the next page.
- `CreateProjectDialog`: the submit button is disabled with `aria-busy` while pending, opens the
  upload hand-off for `sourceType: 'upload'` and the repository hand-off for `'repository'`,
  and renders a `role="alert"` with the API message on `PROJECT_NAME_TAKEN`.
- `ProjectDetailPage` renders the project name and lifecycle badge, shows the not-found panel on
  `404`, shows the archived banner and disables the chat entry point when archived.
- `ProjectDeleteDialog` renders one row per backend `consequences` entry, keeps confirm disabled
  while the preview loads, and shows an error instead of confirming when the preview fails.
- `HomePage` renders recent projects and their knowledge-status badges, plus its empty state when
  the list is empty.
- `ProjectPickerPage` lists only non-archived projects.
- Mobile assertion: `ProjectsPage` renders without horizontal overflow at a 375 px viewport
  (`.cursor/rules/ui-responsive.mdc`).

### Unhappy paths that must be covered

- List, detail, create, archive, restore, delete and preview failures each render an inline
  `role="alert"` with the API `error.message`, and a generic localized fallback when the body is
  unparseable.
- A `403` on delete keeps the project and shows `errors.forbidden`.
- A `429` shows the backend message including the retry hint when present.
- A correlation id in the error payload is rendered as a reference line.
- An optimistic archive rolls back and shows the error when the request fails.
- No test asserts a hardcoded count, percentage or retention number that the API did not return.

## 10. Definition of Done

- [ ] `ProjectsPage`, `ProjectPickerPage`, `CreateProjectDialog`, `ProjectDetailPage`,
      `ProjectOverview` identity block and the two Home sections no longer import `useAppData`.
- [ ] `shared/mock-data` is still imported only by Chat, Knowledge, Sources, Changes, Health and
      Processing, and the `mockProject` outlet field is the only bridge in the project shell.
- [ ] Every lifecycle and knowledge-health value is rendered through `projectStatusMap.ts`; no
      other file compares against a backend state string except the archived and askable rules.
- [ ] Ready and Partially available are visually and textually distinct.
- [ ] No user-facing string is hardcoded; every new key exists in `en.json`.
- [ ] All server state goes through React Query; no `fetch` inside `useEffect`.
- [ ] Every action button has a loader, `disabled`, `aria-busy` and an inline `role="alert"`.
- [ ] Archive, restore and delete all work end to end against the real backend, and archived
      projects are absent from the default list, the picker and Home.
- [ ] The delete dialog shows only backend-provided consequences and counts.
- [ ] No horizontal scroll at 375 px, 768 px and 1280 px on every screen this phase touches.
- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass in `frontend/` with ≥ 80% line and
      branch coverage on the touched files.

## 11. Documentation & ADR updates

- Note in `docs/plan/README.md` §3 (frontend state) — when that section is next revised — that
  the projects feature is off mock data; do not edit the phase table.
- No ADR is expected. Write one only if the `mockProject` bridge or the unknown-state fallback
  becomes a general pattern other slices must follow.
- If Phase 13 documented the API-client conventions in `docs/`, extend that document with the
  projects query-key namespace rather than creating a new file.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **"Recently accessed" projects.** Frontend §8 asks for recently *accessed* projects, but the
   backend has no access timestamp. Options: order by `updatedAt` and rename the section,
   add `lastAccessedAt` to Phase 17's model, or track recents client-side. A client-side recents
   list would be UI-owned business state, which backend §152 discourages.
2. **Knowledge-health vocabulary.** The mapping table assumes the enum proposed in Phase 17
   (`none|updating|ready|partial|stale|failed`), while frontend §8 shows "Needs attention" and
   "Outdated". Confirm the backend enum and the display names before this table is written —
   this is the same question as Phase 17's open question 3.
3. **Search semantics.** `GET /projects?q=` is assumed to match the name and description
   prefix/substring, case-insensitively. Confirm, because the current UI filters on name only.
4. **Restore availability.** Phase 17 supports restore. Should the UI expose it only from the
   archived list, or also from a global "archived projects" admin view? Frontend §81B says
   "when restoration is supported" without naming a location.
5. **Hard delete.** Frontend §81B forbids hard delete from the product UI unless the backend
   exposes a purge path. Confirm that the delete action stays a soft delete with no purge
   affordance in this slice.
6. **`ProjectOverview` split.** The identity block moves to the API while the capability sections
   stay mocked, so the screen is briefly half-real. Confirm that this is preferable to leaving
   the whole overview on mocks until Phase 40.
7. **Scope check.** Seven files rewired plus a new dialog, a new mapping module and five hooks is
   at the upper end of one reviewable pull request. If the `ProjectDeleteDialog` plus deletion
   preview needs more than the remaining budget, it should split into its own follow-up phase
   rather than push this one past two days.
