# Phase 33 — Frontend source upload slice

- **Layer:** FE
- **Depends on:** Phase 19 (frontend projects slice), Phase 24 (upload persistence)
- **Unblocks:** — (nothing in the README index requires this phase as a hard dependency)
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §15 (source upload), §16 (folder upload),
  §17 (ZIP fallback), §18 (upload preview), §19 (upload progress), §89 (loading states),
  §90 (error states), §98 (technical realism), §99 (minimal clicks); `backend/requirments.md`
  §10–§13 (upload and source versions); `backend/solution.md` §4.1–§4.3; decision **D7**
  (replace mock data feature by feature)

## 1. Goal

After this phase `SourceUploadDialog` uploads real project archives to the backend and hands
off to the ingest job the API enqueues. The dialog no longer calls `useAppData().addUpload` or
simulates ingest progress with fake file counts and percentages.

You can see it working by opening upload from project creation or the Sources tab, choosing a
ZIP, watching **HTTP upload** progress (bytes sent), receiving `202 { sourceVersionId, jobId }`,
and landing on a path where Phase 35 can show worker progress. Additional uploads on the same
project enqueue new versions without creating a new project (frontend §15).

## 2. Why this phase is here

Phase 19 rewired the project shell and opens `SourceUploadDialog` with a real `projectId`, but
the dialog still performs client-side folder analysis against mock noise patterns. Phase 24
defines the only upload HTTP contract today. Wiring the dialog here completes *Provide Source*
for the upload path before Phase 35 renders ingest jobs and before Phase 36 lists source
versions.

It cannot come earlier: there is no authenticated multipart endpoint until Phase 24. It should
not absorb Phase 35 (worker stages) or invent server-side preview counts Phase 24 deliberately
omits from the `202` body.

## 3. Scope

### In scope

- A `sources` API module and React Query mutation for `POST /projects/:projectId/sources`
  with required `Idempotency-Key` and `multipart/form-data` field `archive` (Phase 24 §6).
- **HTTP upload progress** via `XMLHttpRequest` or an equivalent progress-capable client wrapper
  around the Phase 13 API transport — not worker ingest percentages (frontend §19 vs §20).
- `SourceUploadDialog.jsx` rewired: pick file, optional pre-submit summary limited to what the
  client knows (file name, selected size), upload, success hand-off, error display.
- i18n for every new or changed string; removal of this dialog’s mock-data imports.
- Colocated tests: mutation, dialog states, unhappy paths, 375 px layout smoke.

### Out of scope (owner phase)

- Processing center, job polling, stage checklist — **Phase 35**.
- Sources tab version history and connection metadata — **Phase 36**.
- Folder / multi-file upload without a backend contract — **blocked** until product confirms
  zip-only vs multipart (Phase 24 §12 open question 1); this phase must not ship folder upload
  silently.
- Client-side `node_modules` exclusion preview that pretends to match Phase 23 — **forbidden**
  unless a dedicated validate endpoint exists and is approved.
- Deleting all of `shared/mock-data/` — **D7** removes only this feature’s usage.
- Playwright — **Phase 63**.

## 4. Design

### 4.1 Feature layout

```text
frontend/src/features/projects/
  api/sourcesApi.js           POST upload + idempotency header helper
  api/sourceTypes.js          DTO types for upload response (Phase 24 §6)
  hooks/useUploadSource.js    mutation + upload progress state
  SourceUploadDialog.jsx      rewired UI (still exported from index.js)
```

React Query:

```text
mutation key: ['projects', projectId, 'sources', 'upload']
onSuccess: invalidate ['projects', 'detail', projectId],
           ['projects', projectId, 'jobs'] (when Phase 35 adds that key),
           optional ['projects', projectId, 'sourceVersions'] (Phase 36)
```

The mutation accepts `{ projectId, file, idempotencyKey, onUploadProgress }`. Progress callbacks
report **bytes uploaded / total bytes** of the single archive field only.

### 4.2 Upload UX vs backend reality (anti-invention)

| UI need (requirements) | What this phase may show | Source |
|---|---|---|
| ZIP upload | Yes — `archive` field | Phase 24 §6 **PROPOSED** |
| Folder upload | Only after BE + product confirm | Phase 24 §12 Q1 — **ask user** |
| File/folder/excluded counts before submit | File name + archive size only, unless validate API approved | Phase 24 §12 Q3 — no counts in `202` |
| “4,821 files / 1,203 excluded” preview | **No** — do not simulate Phase 23 engine in the browser | frontend §98 |
| Progress bar during upload | Byte ratio or indeterminate while streaming | frontend §19 |
| Progress during ingest | Link/copy to Processing — **Phase 35** | frontend §20 |
| Partial upload failure | `error.message` from envelope | frontend §90 |

When zip-only is confirmed, folder picker and drag-drop of directories are **hidden** or replaced
with §17 copy (`sources.folderUnsupported`) and a ZIP-only control — do not leave a broken folder
path that never hits the API.

### 4.3 Idempotency and retries

Generate a fresh `Idempotency-Key` (UUID) per user-initiated upload attempt. Re-submitting after
a network failure may reuse the same key only when the UI knows the prior request may still be
in flight — mirror Phase 12 semantics: `409 IDEMPOTENCY_IN_FLIGHT` shows a localized “still
processing” message; `409 IDEMPOTENCY_KEY_REUSE` with a different body is treated as an error
with `error.message`.

### 4.4 Action feedback (required)

Submit control: inline spinner, `disabled` + `aria-busy="true"` while uploading, form controls
disabled, inline `role="alert"` sourced from `error.message` (e.g. `SOURCE_ZIP_SLIP`,
`SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS`, `VALIDATION_ERROR`). Clear the alert when the user
changes the selected file. Show correlation `error.reference` when present (frontend §90).

Do **not** show in-app copy that implies client-side rate limiting; if the API returns
`429 RATE_LIMITED`, render `error.message` and optional `details.retryAfterSec` only.

### 4.5 Success hand-off

On `202`:

1. Close the dialog (or show a brief success state with i18n “upload queued”).
2. Call optional `onUploaded({ sourceVersionId, jobId })` from Phase 19 create flow.
3. Invalidate project detail so lifecycle badges can move toward `source_received` / `processing`
   when the backend updates them (Phase 17/25 — UI does not set lifecycle locally).

Navigation to `/processing` or the project Processing tab is optional in this phase if routes
exist; at minimum expose the `jobId` to Phase 35 hooks via cache invalidation.

### 4.6 Responsiveness

Dialog near full viewport width at 375 px; drop zone and progress stack vertically; no horizontal
scroll at 375 / 768 / 1280 on the dialog and its tests.

## 5. Data model changes

**None** (frontend). Consumes Phase 24 `SourceVersion` / job ids returned in JSON only.

## 6. API contract — PROPOSED (needs approval before implementation)

This phase **defines no new backend endpoints**. It consumes Phase 24 §6 unchanged. All paths
below remain **PROPOSED** until the owning backend phase is approved and implemented.

### Consumed: `POST /api/v1/projects/:projectId/sources` (Phase 24)

- **Permission:** `sources.upload` + project membership.
- **Headers:** `Idempotency-Key` (required).
- **Body:** `multipart/form-data`, field `archive` (zip).
- **Response `202`:** `{ "sourceVersionId", "jobId" }`.
- **Errors:** `400` source validation codes, `401`, `403`, `404`, `409` idempotency, `429`
  — envelope `{ error: { code, message, details? } }`.

### Not consumed in this phase (no assumption)

- Any **pre-upload validate** or **multipart file list** endpoint — not in Phase 24; if added
  later, Phase 33 may be extended in a follow-up PR after approval.

Frontend hook return shape (for later slices):

```json
{
  "sourceVersionId": "665a00000000000000000001",
  "jobId": "665f1c9d4b2a8e0012a4f001"
}
```

## 7. Configuration & environment variables

**None new.** API base URL comes from Phase 13. Max archive size is enforced by the backend
(Phase 23 constants); the UI may read a documented constant from a shared module **only after**
the backend exposes it via OpenAPI or a config endpoint — do not hardcode a limit that can drift.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/projects/api/sourcesApi.js` | **New:** multipart POST + progress |
| `frontend/src/features/projects/api/sourcesApi.test.js` | **New:** idempotency header, error mapping |
| `frontend/src/features/projects/api/sourceTypes.js` | **New:** upload response types |
| `frontend/src/features/projects/hooks/useUploadSource.js` | **New:** mutation + progress state |
| `frontend/src/features/projects/hooks/useUploadSource.test.jsx` | **New:** success, 409, 400 paths |
| `frontend/src/features/projects/SourceUploadDialog.jsx` | Remove `useAppData`; zip upload flow |
| `frontend/src/features/projects/SourceUploadDialog.test.jsx` | Rewrite: pending, progress, errors |
| `frontend/src/features/projects/index.js` | Export upload hook if needed by Sources panel |
| `frontend/src/shared/i18n/locales/en.json` | Upload strings, zip-only fallback, error keys |
| `frontend/src/shared/mock-data/AppDataContext.jsx` | **No change** unless `addUpload` becomes unused — then remove only that export usage from upload feature |

`CreateProjectDialog.jsx` keeps opening this dialog; no mock bridge changes beyond stopping
upload-side mock writes.

## 9. Tests (≥ 80% line and branch)

### Unit

- `sourcesApi` sets `Idempotency-Key`, sends `archive` field name, surfaces `error.message`.
- `useUploadSource` maps progress events monotonically; resets on new file selection.

### Component (Testing Library, mocked API)

- Dialog: submit disabled with `aria-busy` while upload in flight.
- Success: calls `onUploaded` with ids from `202`.
- `400 SOURCE_ZIP_SLIP`: `role="alert"` with API message.
- `409 IDEMPOTENCY_IN_FLIGHT`: localized handling without second concurrent POST.
- Correlation id rendered when `error.reference` present.
- 375 px viewport: no horizontal overflow.

### Unhappy paths

- Network failure mid-upload: error alert + retry allowed with new idempotency key.
- `403`: forbidden copy; no blind retry loop.
- No assertion on fabricated file/excluded counts not returned by API.

## 10. Definition of Done

- [ ] `SourceUploadDialog` does not import `useAppData` or `NOISE_PATTERNS` from mock-data.
- [ ] Upload uses Phase 24 POST with `Idempotency-Key` and field `archive`.
- [ ] Progress UI reflects **HTTP upload** only; no fake ingest % or file-processed counts.
- [ ] Folder upload is **not** enabled unless product confirmed zip-only vs multipart (§12 Q1).
- [ ] All user-facing strings via i18n; action feedback rule satisfied on submit.
- [ ] No horizontal scroll at 375 / 768 / 1280 on the dialog.
- [ ] `npm run lint` and `npm test` in `frontend/` with ≥ 80% line and branch on touched files.

## 11. Documentation & ADR updates

- None required unless upload hand-off conventions are documented in Phase 13 API client notes
  (query invalidation for `jobId`).
- Do not edit README §6 table.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Zip only vs folder/multipart (Phase 24 §12 Q1).** Phase 24 proposes zip-only. Frontend
   §15–§16 ask for folder upload. Must product ship ZIP-only in MVP with §17 fallback copy, or
   wait for a multipart contract? **This phase must not implement folder upload until answered.**
2. **Pre-upload preview counts (Phase 24 §12 Q3).** §18 wants file/excluded counts before
   processing. Without a validate endpoint, only archive size/name is honest. Should backend add
   `POST .../sources/validate`, or should UI drop rich preview until after enqueue (Phase 35
   events)?
3. **Lifecycle transition on first upload (Phase 24 §12 Q2).** Which badge the user sees
   immediately after `202` depends on Phase 17/24 — confirm enum timing for dialog success copy.
4. **Upload size limit in UI.** Should the client read max bytes from a shared constant mirrored
   from Phase 23, or fail only on server `400`?
5. **Hand-off navigation.** After upload, auto-navigate to Processing center vs stay on Sources
   (Phase 36) vs overview banner only?
6. **Additional upload entry points.** Besides create hand-off and Sources panel, any other
   triggers must use the same hook — list them if requirements add more later.
