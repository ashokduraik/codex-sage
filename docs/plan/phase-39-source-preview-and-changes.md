# Phase 39 — Source preview, change summary & documentation conflicts

- **Layer:** BE
- **Depends on:** Phase 26 (materialized paths, `DocumentSection`, GridFS bytes), Phase 29
  (path+hash diff summary persisted for each successful publish)
- **Unblocks:** Phase 40, 57 (evidence preview paths)
- **Size:** 1–2 days
- **Requirements covered:** backend §83, §84, §128, §133, §134; solution §11.3; arch §7–§8;
  `docs/permissions.md` (`sources.preview`)

## 1. Goal

After this phase authorized users can **preview** project source and documentation through bounded
HTTP reads — file metadata plus line-bounded slices — and retrieve a **change summary** after
source updates (counts, affected areas, optional documentation-vs-code conflict records). Bytes
come from GridFS / the materialized workspace for the **current** source version unless the route
explicitly targets a historical diff record. Graph-excluded files remain previewable when
authorized but are labeled **`excludedFromGraph: true`** and must not be presented as
graph-derived knowledge (architecture §7). Preview bodies are capped by a **named constant**
pending evaluation (phase 05), not an untested fixed line count (solution §11.3).

## 2. Why this phase is here

Frontend §67, §73, and §100 need real file preview and change panels; phase 26 stores bytes and
sections and phase 29 computes the diff that feeds impact copy (backend §83). Browse (37) and
search (38) intentionally avoid returning raw file content. This phase is the controlled gate for
bytes on the wire. It precedes phase 40 (`ChangesPanel`, preview drawers) and phase 57 (evidence
deep links) but does not run conflict **detection** unless an algorithm is approved — see
section 12.

## 3. Scope

### In scope

- Module `backend/src/modules/sources/` extended (or `sourcePreview/` sub-module) for preview
  routes — keep public surface in `modules/sources/index.js`.
- Solution §11.3 routes:
  - `GET /api/v1/projects/:projectId/files?path=`
  - `GET /api/v1/projects/:projectId/files/slice?path=&startLine=&endLine=`
- Permission `sources.preview` + project membership; scope `orgId + projectId + status: 'A'`;
  cross-tenant → `404`.
- Path safety: normalize project-relative path; reject `..`, absolute paths, NUL bytes.
- Read from current `SourceVersion` linked to `currentKnowledgeVersionId` (phase 28); join
  `SourceFile` for `excludedFromGraph`, `sha256`, size.
- Line slice: UTF-8 safe truncation; enforce **`SOURCE_PREVIEW_MAX_BYTES`** (and optional token
  estimate hook for phase 43 — count only if honest).
- **Change summary** HTTP surface reading phase 29 persisted diff (PROPOSED path in section 6).
- Label excluded files in every preview response.
- Never log raw file bodies.

### Out of scope (owner phase)

- Knowledge browse/search — **phases 37–38**.
- Chat SSE or agent `read_file_slice` tool — **phases 46, 50** (may call same service fn).
- Running diff computation — **phase 29** (this phase reads stored summary).
- Automated documentation-vs-code **detection algorithm** — **open**; if none exists, ship
  slice + diff only (section 12).
- Download entire project / bulk export.
- Mandatory audit rows — optional `source.preview` audit (solution §9.2, backend §134) is **open**.
- In-app rate limiting.

## 4. Design

### 4.1 Preview read path

```text
JWT + sources.preview + project ACL
  → resolve current sourceVersionId (+ knowledgeVersionId for labels)
  → normalize path → load SourceFile row (status A)
  → if missing → 404 SOURCE_NOT_FOUND
  → load bytes: GridFS preferred; workspace fallback if phase 26 guarantees sync
  → for slice: extract lines [startLine, endLine] inclusive, cap total bytes
  → attach metadata: excludedFromGraph, contentType, sha256, sizeBytes
  → optional audit hook (disabled by default — §12)
```

Graph-excluded files: preview allowed; response includes:

```json
"graphCoverage": { "includedInGraph": false, "reason": "over_graph_size_limit" }
```

### 4.2 Change summary read path

Phase 29 persists a summary per successful transition (added/modified/removed paths, optional
**impact tags** — backend §83). This phase exposes the latest (or version-specific) summary:

```text
GET .../knowledge/updates/latest   OR   GET .../sources/change-summary
  → read persisted diff document(s) for org/project
  → map to FE §73 shape: counts, affected workflows/APIs, conflicts[]
```

Functional impact fields (`3 APIs changed`) appear only when phase 29 (or this phase) can derive
them honestly from graph diff metadata — otherwise return file counts only and omit API/workflow
counts rather than fabricate.

### 4.3 Documentation vs code conflicts (backend §84, §128, frontend §73)

Requirements describe UX and evidence preservation, not a detection algorithm. **If no detector
is approved before implementation**, the API returns `"conflicts": []` and section 12 tracks
conflict work as a follow-up. If approved, conflicts are read-only records stored at publish time
(phase 28/29), each with:

```json
{
  "concept": "Checkout confirmation",
  "documentation": { "path": "docs/checkout.md", "excerpt": "…" },
  "code": { "path": "src/checkout/confirm.js", "excerpt": "…" }
}
```

Excerpts are bounded by the same byte cap as slices.

### 4.4 Knowledge update interaction

Preview remains available during graph update for **bytes** (architecture §7: excluded files may
still preview). Change summary may reference the diff that triggered the current update even
while `knowledgeHealth` is `updating`; confirm UX in section 12.

## 5. Data model changes

**Reads only** from phase 24 `SourceFile`, phase 26 `DocumentSection`, phase 29 diff store.

If phase 29 has not defined the diff collection yet, this phase **PROPOSED** additive collection:

| Collection | Fields |
|---|---|
| `sourceChangeSummaries` | `orgId`, `projectId`, `sourceVersionId`, `previousSourceVersionId?`, `knowledgeVersionId`, `counts: { added, modified, removed }`, `paths: { added[], modified[], removed[] }`, `impact: { apis?, workflows?, docs? }`, `conflicts[]`, `createdAt`, `status: 'A'|'D'` |

Index: `{ orgId, projectId, createdAt: -1 }` partial `{ status: 'A' }`.

Confirm ownership with phase 29 before creating duplicate storage.

## 6. API contract — PROPOSED (needs approval before implementation)

### `GET /api/v1/projects/:projectId/files`

- **Query:** `path` (required, project-relative)
- **Response `200`:**

```json
{
  "path": "src/payments/refund.js",
  "sourceVersionId": "01J...",
  "knowledgeVersionId": "01J...",
  "sizeBytes": 4200,
  "sha256": "…",
  "contentType": "text/javascript",
  "excludedFromGraph": false,
  "graphCoverage": { "includedInGraph": true, "reason": null },
  "lineCount": 188,
  "previewAvailable": true
}
```

- **Errors:** `404` file or project not found, `400` path unsafe, `403` forbidden.

### `GET /api/v1/projects/:projectId/files/slice`

- **Query:** `path` (required), `startLine` (required, ≥1), `endLine` (required, ≥ startLine)
- **Response `200`:**

```json
{
  "path": "src/payments/refund.js",
  "sourceVersionId": "01J...",
  "startLine": 40,
  "endLine": 55,
  "excludedFromGraph": false,
  "graphCoverage": { "includedInGraph": true, "reason": null },
  "content": "…lines…",
  "truncated": false,
  "truncatedReason": null
}
```

When `endLine - startLine + 1` or UTF-8 byte size exceeds cap → truncate with
`truncated: true`, `truncatedReason: 'byte_cap'` (never silent overflow).

- **Errors:** same as metadata route; `416` or `400` if line range invalid — pick one in review.

### `GET /api/v1/projects/:projectId/knowledge/updates/latest`

*(Alternative path `GET .../sources/change-summary` — confirm one canonical URL.)*

- **Permission:** `knowledge.view` or `sources.preview` — confirm in section 12.
- **Response `200`:**

```json
{
  "sourceVersionId": "01J...",
  "knowledgeVersionId": "01J...",
  "publishedAt": "2026-09-12T10:00:00.000Z",
  "counts": { "added": 24, "modified": 17, "removed": 8 },
  "impact": {
    "apisChanged": null,
    "workflowsChanged": null,
    "documentationConflicts": 0
  },
  "paths": {
    "added": [{ "path": "src/payments/refund.js", "impact": null }],
    "modified": [],
    "removed": []
  },
  "conflicts": []
}
```

`impact` numeric fields are `null` when unknown — frontend §73 must not show zero as a fake count.

- **Response `404`:** no summary yet (new project).

**Errors (all routes):** standard envelope; no raw stack traces.

## 7. Configuration & environment variables

**None.**

| Constant | Proposed value | Where | Purpose |
|---|---|---|---|
| `SOURCE_PREVIEW_MAX_BYTES` | **pending evaluation** | `sources.preview.constants.js` | Max UTF-8 bytes per slice response (solution §11.3) |
| `SOURCE_PREVIEW_MAX_LINES` | **pending evaluation** | same | Secondary guard when byte cap not yet calibrated |
| `SOURCE_PATH_MAX_LENGTH` | `1024` | same | Reject absurd paths |

Do not ship production numeric caps until phase 05 / tokenizer parity confirms safe bounds; tests
may use a small fixed cap via test-only injection.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/sources/sourcePreview.service.js` (+ `.test.js`) | Bytes + slice logic |
| `backend/src/modules/sources/sourcePreview.routes.js` (+ `.test.js`) | File routes |
| `backend/src/modules/sources/changeSummary.service.js` (+ `.test.js`) | Read diff records |
| `backend/src/modules/sources/changeSummary.routes.js` (+ `.test.js`) | Latest summary route |
| `backend/src/modules/sources/sources.schemas.js` | Extend validation |
| `backend/src/modules/sources/sources.repository.js` | Path lookups, GridFS read |
| `backend/src/modules/sources/sources.preview.constants.js` | Byte/line caps |
| `backend/src/modules/sources/index.js` | Export routes |
| `backend/src/modules/audit/audit.actions.js` | **Optional** `source.preview` action if policy enabled |
| `backend/src/http/routes.js` | Register preview + change routes |

## 9. Tests (≥ 80% line and branch)

### Unit

- Path normalizer rejects `../etc/passwd` and absolute paths.
- Slice truncates when byte cap exceeded; sets `truncated: true`.
- Excluded file metadata sets `includedInGraph: false`.
- Change summary maps phase 29 fixture; null impact when graph counts unavailable.

### Integration

- Preview known file → correct lines and hash.
- Missing path → `404`.
- Cross-tenant → `404`.
- Missing permission → `403`.

### Unhappy paths

- `startLine` > `endLine` → `400`.
- Binary file preview policy: return `previewAvailable: false` or octet-stream disabled — confirm
  in section 12.

## 10. Definition of Done

- [x] File metadata and slice routes match the approved contract.
- [x] Slice responses enforce byte cap constant (test uses injectable cap).
- [x] Excluded-from-graph labeling on every preview payload.
- [x] Change summary route reads phase 29 storage; no fabricated API/workflow counts.
- [x] No full-project leakage; no secrets in logs/responses.
- [x] Optional audit not enabled until policy answered.
- [x] Coverage ≥ 80%; lint and tests green.

## 11. Documentation & ADR updates

- `docs/architecture.md` §8: preview + change summary routes.
- `docs/data-model.md`: document `sourceChangeSummaries` if this phase creates it (coordinate
  with phase 29).
- ADR only if conflict detection algorithm is approved in this slice.

## 12. Risks & open questions

1. **Scope split:** If solution has no conflict-detection algorithm, is phase 39 **slice + diff
   only**, with `conflicts[]` always empty until a later phase/ADR?
2. **`SOURCE_PREVIEW_MAX_BYTES` value:** Blocked on evaluation — what interim cap is acceptable
   for local dev tests only?
3. **Optional `source.preview` audit:** Should every slice/metadata read write audit when org
   policy enables it (solution §9.2, backend §134), or defer entirely?
4. **Canonical change-summary URL:** `/knowledge/updates/latest` vs `/sources/change-summary`?
5. **Permission on change summary:** `sources.preview` vs `knowledge.view`?
6. **Historical preview:** May users slice files from a **previous** source version listed in
   change summary, or current version only?
7. **Binary / generated files:** Return metadata-only or `415` for slice?
