# Phase 40 — Frontend knowledge, search & changes slice

- **Layer:** FE
- **Depends on:** Phase 19 (projects shell, routing, API client), Phase 37 (knowledge browse API),
  Phase 38 (search API), Phase 39 (preview + change summary API)
- **Unblocks:** Phase 57 (evidence preview polish can extend same components)
- **Size:** 1–2 days
- **Requirements covered:** frontend §66–§74, §100; backend browse/search/preview contracts
  (phases 37–39, PROPOSED until approved)

## 1. Goal

After this phase the Knowledge Explorer, Search panel, source preview affordances, and Changes
view load **real server state** via React Query instead of `mockProject.knowledgeTree` and local
search indexes. The explorer renders **only categories the backend marks as available** (frontend
§71). Search shows typed results from `GET .../search` with Open and Ask about this actions
that **prepare chat context** but do not execute streaming answers (phase 55). Changes and
health surfaces consume phase 39 summary and phase 37 health endpoints. Mock imports for
knowledge/search/change data are removed; other features may still use mocks until their phases
land.

## 2. Why this phase is here

The UI already has `KnowledgeExplorer.jsx`, `SearchPanel.jsx`, and `ChangesPanel.jsx` on mock
data (D7). Backend phases 37–39 define the contracts; phase 19 supplies HTTP + React Query.
This slice must not precede those APIs or the explorer will invent nodes (violating §71). It
must not implement ask **execution** — only navigation and composer prefill/context handles for
phase 50/55.

## 3. Scope

### In scope

- React Query hooks under `frontend/src/features/knowledge/` (and shared API helpers if needed).
- Rewire:
  - `KnowledgeExplorer.jsx` → `GET .../knowledge` + facet sub-routes (`/summary`, `/workflows`,
    `/apis`, `/symbols`).
  - `SearchPanel.jsx` → `GET .../search`.
  - `ChangesPanel.jsx` → `GET .../knowledge/updates/latest` (or approved path from phase 39).
- Source preview UI (drawer or panel): `GET .../files` + `.../files/slice` for Open from search
  and explorer (frontend §67).
- Knowledge health block (frontend §74) from `GET .../knowledge/health` — coordinate with phase
  36 project health so two badges do not contradict; prefer knowledge health route as authority
  on the Knowledge tab.
- **Ask about this** (§68, §70, §100): navigate to embedded chat route with structured context
  (result id, path, knowledge version) in location state or query — **no** `POST` message.
- i18n for all new/changed strings in `shared/i18n/locales/en.json`.
- Action feedback: loading, disabled, `aria-busy`, inline `role="alert"` errors from API
  `error.message`.
- Remove mock usage: `knowledgeTree` search index in `SearchPanel`, `MOCK_CHANGES` in
  `ChangesPanel`, `mockProject` fallback in explorer when API project is present.
- Mobile layouts 375 / 768 / 1280 px without horizontal scroll.

### Out of scope (owner phase)

- Streaming chat / SSE answer rendering — **phase 55**.
- Resolving search attachments on send — **phase 50** (backend resolver).
- Evidence cards inside messages — **phase 57**.
- Data / live-DB explorer nodes — **later slice** (§71, §74).
- Processing center, upload, repo connect — **phases 33–35**.
- Replacing non-knowledge mocks globally — only this feature's mock deletion per D7.

## 4. Design

### 4.1 Data flow

```text
ProjectDetail outlet (phase 19)
  → useKnowledgeFacets(projectId)     GET /knowledge
  → useKnowledgeSummary / workflows / apis / symbols  (lazy per expanded facet)
  → useProjectSearch(projectId, q, types)
  → useChangeSummary(projectId)
  → useKnowledgeHealth(projectId)
  → useSourcePreview(projectId, path, lineRange)  on demand
```

Query keys include `projectId` and `knowledgeVersionId` when returned from API so a publish
invalidates explorer/search caches (`queryClient.invalidateQueries` on project refetch from phase
36 hooks if shared).

### 4.2 Explorer tree (frontend §71)

- Root loads `facets[]` from `GET /knowledge`. Render a top-level node only when
  `available: true`.
- Do **not** render hardcoded categories (Capabilities, Data, Integrations, …) unless the API
  lists them.
- Child fetches use the matching sub-route; show skeletons while loading; empty facet → omit or
  show i18n empty hint inside parent, not fake children.
- Relationship drill-down (Checkout → Order Service → …) appears only if API returns nested
  `items` / `children` — no client-side graph inference.

### 4.3 Search panel (frontend §72)

- Debounced `q` input; type chips map to `types` query param tokens from phase 38 (`code`, `doc`,
  `symbol`, `workflow`, `api`).
- Hide **Data** chip unless backend returns `type: 'data'` hits in a probe query — default hidden
  for MVP.
- Result row actions:
  - **Open** → preview drawer (slice around `sourceRef` lines).
  - **Ask about this** → `navigate(/projects/:id/chat, { state: { searchAttachment: { id, knowledgeVersionId } } })`
    (exact shape PROPOSED until phase 50 confirms).
- `503 KNOWLEDGE_UNAVAILABLE` → inline alert + link to processing/health (phase 36).

### 4.4 Changes panel (frontend §73)

- Render counts and path lists from API; show `impact` fields only when non-null.
- Conflicts section: when `conflicts[]` empty, show neutral copy — do not use mock conflicts.
- Doc vs code UI uses excerpts from API; open preview on both paths.

### 4.5 Preview drawer (frontend §67)

- Header: file name, path, line range, `excludedFromGraph` badge when true (i18n partial
  knowledge copy from §74).
- Body: monospace slice content; truncated banner when `truncated: true`.
- Back navigation preserves conversation route when opened from chat (phase 54+); from knowledge
  tab, return to explorer/search selection.

### 4.6 Ask about this without execution (§68, §70)

- Explorer/search links set composer **placeholder context** only; sending waits for phase 55.
- Do not call chat SSE endpoints from this phase.
- Optional: prefill composer text with a neutral template — confirm product preference in
  section 12 (vs empty composer with attachment chip).

### 4.7 Error and empty states

- No knowledge yet: empty explorer consistent with phase 36 health (processing vs failed).
- Permission errors: `403` message from API.
- All user-visible strings via `t('…')`.

## 5. Data model changes

**None** (frontend). TypeScript not used — `.js` / `.jsx` only.

## 6. API contract — PROPOSED (needs approval before implementation)

This phase **consumes** contracts from phases 37–39 unchanged. No new HTTP routes on the
frontend. If backend contracts change during approval, update hooks in the same PR as backend
changes.

Document expected hook → route mapping in code comments referencing phase docs:

| Hook | Backend phase |
|---|---|
| `fetchKnowledgeFacets` | 37 |
| `fetchProjectSearch` | 38 |
| `fetchSourceSlice` | 39 |
| `fetchChangeSummary` | 39 |

## 7. Configuration & environment variables

**None.** Uses existing API base from phase 13. Search debounce ms is a named constant in the
feature module (`KNOWLEDGE_SEARCH_DEBOUNCE_MS`, e.g. `300`).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/knowledge/api/knowledge.api.js` | Browse + health fetchers |
| `frontend/src/features/knowledge/api/search.api.js` | Search fetcher |
| `frontend/src/features/knowledge/api/preview.api.js` | File metadata + slice |
| `frontend/src/features/knowledge/api/changes.api.js` | Change summary |
| `frontend/src/features/knowledge/hooks/useKnowledgeFacets.js` (+ tests) | React Query |
| `frontend/src/features/knowledge/hooks/useProjectSearch.js` (+ tests) | React Query |
| `frontend/src/features/knowledge/hooks/useSourcePreview.js` (+ tests) | React Query |
| `frontend/src/features/knowledge/hooks/useChangeSummary.js` (+ tests) | React Query |
| `frontend/src/features/knowledge/KnowledgeExplorer.jsx` | Remove mock tree |
| `frontend/src/features/knowledge/SearchPanel.jsx` | Remove local index |
| `frontend/src/features/knowledge/SourcePreviewDrawer.jsx` (+ test) | **New** preview UI |
| `frontend/src/features/projects/ChangesPanel.jsx` | Wire change summary API |
| `frontend/src/shared/i18n/locales/en.json` | New keys for facets, errors, excluded badge |
| `frontend/src/shared/mock-data/mockData.js` | Remove or stop exporting `knowledgeTree` used by knowledge feature |
| `frontend/src/features/knowledge/*.test.jsx` | Update for API mocks (msw or inject fetch) |

## 9. Tests (≥ 80% line and branch)

### Component / hook tests (Vitest + Testing Library)

- Explorer renders only facets returned by mocked `GET /knowledge`.
- Explorer does not show Data category when API omits it.
- Search debounces input; displays typed results; Open opens preview with correct path.
- Ask about this navigates to chat route with attachment state; **no** SSE fetch called.
- Changes panel shows API counts; hides null impact fields.
- Preview shows excluded-from-graph badge when API flag set.
- `503` knowledge unavailable surfaces alert text from envelope.

### Unhappy paths

- Empty search query does not call API (or calls with validation — match backend).
- Network error → `role="alert"` inline message.

## 10. Definition of Done

- [x] Knowledge explorer, search, changes, and preview use React Query + real API (approved
      contracts).
- [x] No `mockProject.knowledgeTree` / `MOCK_CHANGES` / local search index in these features.
- [x] Explorer categories match backend facets only (§71).
- [x] No Data/live-DB nodes; no fabricated API/workflow impact numbers.
- [x] Ask about this navigates only; no chat execution (phase 55).
- [x] i18n complete; action feedback on interactive controls.
- [x] Responsive at 375/768/1280; keyboard reachable tree/search.
- [x] Tests ≥ 80% line and branch on touched files; lint green.

## 11. Documentation & ADR updates

- None required unless hook attachment shape becomes a cross-app contract — then note in
  `frontend/requirments.md` cross-link only if product asks.
- Ensure `docs/plan/README.md` links resolve (no README edit unless filename drift).

## 12. Risks & open questions

1. **Chat attachment shape:** Query param vs router state vs future composer chip component for
   phase 50/55?
2. **Health duplication:** Phase 36 shows project health on Sources; should Knowledge tab hide
   duplicate badges or merge API responses?
3. **Symbol search UX:** Separate symbols facet in explorer vs search-only — depends on phase 37
   CodeGraph coverage.
4. **Prefill vs empty composer** for Ask about this (§68).
5. **Mock removal scope:** Delete `knowledgeTree` from all mock projects or only stop importing
   in knowledge feature (other tests may still reference until global mock deletion)?
