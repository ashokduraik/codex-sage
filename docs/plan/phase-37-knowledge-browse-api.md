# Phase 37 — Knowledge browse API

- **Layer:** BE
- **Depends on:** Phase 28 (published `KnowledgeVersion`, project `knowledgeHealth`, Q&A gate,
  current graph identity on the project)
- **Unblocks:** Phase 40, 46 (agent tools reuse the same read paths internally)
- **Size:** 1–2 days
- **Requirements covered:** backend §24, §25, §85, §130; solution §11.1; arch §7–§8;
  `docs/permissions.md` (`knowledge.view`, `knowledge.browse`)

## 1. Goal

After this phase an authorized caller can explore the **current** project knowledge graph and
document index over HTTP — summary, workflows, APIs, symbol lookup, and a dedicated health
payload — without going through chat agent tools. Every route is scoped to
`orgId + projectId + status: 'A'`, resolves the project's **current** `knowledgeVersionId`,
and reads only through a CodeGraph **read lease** when health allows. During an in-flight graph
writer or recovery, code-graph browse returns a structured **updating / unavailable** response;
it never serves a stale or partially mutated graph. You can see it working by calling
`GET /api/v1/projects/:projectId/knowledge/summary` on a ready project and receiving bounded
metadata, then triggering a re-ingest and watching the same routes return `503
KNOWLEDGE_UNAVAILABLE` (or an agreed `200` wrapper — see section 12) instead of yesterday's
graph.

## 2. Why this phase is here

Frontend §71–§74 and §100 need a real tree and health surface; phase 28 publishes knowledge but
exposes no browse HTTP. Search (phase 38) and preview (phase 39) are separate concerns — browse
is **navigational metadata** from the current graph plus on-demand bounded document reads, not
keyword retrieval. It must follow phase 28 because routes need a published `KnowledgeVersion`,
authoritative `knowledgeHealth`, and the same gate chat will use (architecture §7). It cannot
wait for phase 46: the UI must not depend on LangGraph tools. Phase 40 wires the explorer only
after these contracts exist.

## 3. Scope

### In scope

- New module `backend/src/modules/knowledge/` (`routes + service + repository + tests`,
  public surface in `index.js`).
- Routes from solution §11.1 under `/api/v1/projects/:projectId/knowledge/*`.
- Tenant isolation: every query filters `orgId`, `projectId`, and row `status: 'A'`; cross-org
  or soft-deleted project → `404 NOT_FOUND` (same as other project routes).
- Permission: `knowledge.browse` **or** `knowledge.view` (solution §11.1 — confirm whether both
  are equivalent for read-only browse in section 12).
- Resolve `currentKnowledgeVersionId` from the project; **historical knowledge version ids are
  not accepted** on query strings or path segments.
- CodeGraph reads through the phase 27 adapter with a **read lease**; refuse lease when a writer
  holds the project lock or health is `updating` / `failed` / pre-ready (phase 28 gate).
- Document-side summaries: bounded reads from `DocumentSection` rows (phase 26) for the current
  source version linked to the knowledge version — no embeddings, no vector index.
- Pagination on list endpoints (keyset cursor preferred; see section 6).
- Usage hook point: record a browse call fact for phase 59 — **no rollup implementation here**.

### Out of scope (owner phase)

- Project keyword search and typed result lists — **phase 38** (`search.run`).
- Raw file bytes and line slices — **phase 39** (`sources.preview`).
- LangGraph agent tools (`explore_code`, `list_documents`, …) — **phase 46** (may call the same
  service functions internally).
- Publishing, ingest, graph rebuild — **phases 25–28**.
- Embeddings, vector search, rerankers — **README §5** (forbidden).
- In-app rate limiting — **phase 12 / architecture §10** (not in the Node API).
- Live customer-database entities under explorer "Data" — **later slice** (frontend §71).

## 4. Design

### 4.1 Request path

```text
JWT + project membership
  → RBAC: knowledge.browse OR knowledge.view
  → load Project (orgId, projectId, status A)
  → assertKnowledgeReadable(project)     ← phase 28 internal helper
  → resolve currentKnowledgeVersionId + linked sourceVersionId + workspace path
  → if graph browse needed:
        acquireReadLease(projectId)       ← phase 27 adapter; fail → KNOWLEDGE_UNAVAILABLE
        codegraphQuery bounded(...)
  → if document browse needed:
        knowledgeRepository.listSections(...)
  → map to response DTOs (no raw file bodies on browse routes)
```

`assertKnowledgeReadable` throws or returns a structured unavailable object consistent with
phase 50/51 (`KNOWLEDGE_UNAVAILABLE`, retryable). Browse must **not** block on worker progress;
it only reflects published state and lock presence (architecture §7).

### 4.2 Current graph only

- All CodeGraph calls target the workspace index for the **current** knowledge version.
- There is no `?knowledgeVersionId=` override. Retention of old versions (phase 60) does not
  create queryable historical graphs (solution §11.1, README §5).
- If `knowledgeHealth` is `partially_available`, browse returns what the validated index
  contains and surfaces exclusion counts from the published version metadata (frontend §74).

### 4.3 Endpoint responsibilities (solution §11.1)

| Route | Primary read | Notes |
|---|---|---|
| `GET .../knowledge` | Index / entry | Returns available browse facets for this project (which sub-routes are populated — FE §71 shows **only** what this lists). |
| `GET .../knowledge/summary` | Graph + docs | High-level project summary, capabilities list (backend §130); bounded text, no LLM. |
| `GET .../knowledge/workflows` | CodeGraph | Workflow-oriented nodes/edges if the library exposes them; empty list if unsupported. |
| `GET .../knowledge/apis` | CodeGraph | HTTP/route/API entries if supported. |
| `GET .../knowledge/symbols?q=` | CodeGraph | Prefix/name search over symbols; `q` required, min length constant. |
| `GET .../knowledge/health` | Project + version | Authoritative health breakdown for UI §74 (code, docs, partial exclusions). |

Exact CodeGraph query shapes are **not** fixed in this plan — the adapter wraps whatever
`@colbymchenry/codegraph` exposes after phase 27. Section 12 lists which facets are MVP if the
library returns less than the requirements tree.

### 4.4 Response shaping for the explorer

Frontend §71 expects categories such as Capabilities, Workflows, Services, APIs, Components,
Functions, Documentation, Integrations. The API returns **only categories with data**:

```text
facets[]: { key, labelKey, itemCount, href }   // href = relative sub-route or cursor
items[]:  { id, kind, title, subtitle?, sourceRef?, excludedFromGraph? }
```

`id` values must be stable for the current knowledge version so phase 38 search and phase 50
"ask about this" can re-resolve them (architecture §8). Do not invent graph nodes the index
does not contain.

### 4.5 Failure and unavailable states

| Condition | HTTP | Code |
|---|---|---|
| Project not found / wrong org / `status: 'D'` | 404 | `NOT_FOUND` |
| Missing permission | 403 | `FORBIDDEN` |
| Writer active or health updating/recovering | 503 | `KNOWLEDGE_UNAVAILABLE` |
| Health `failed` (no usable graph) | 503 | `KNOWLEDGE_UNAVAILABLE` |
| CodeGraph read error after lease acquired | 503 | `KNOWLEDGE_UNAVAILABLE` or `SYSTEM_ERROR` — confirm in section 12 |
| Invalid query (`symbols` without `q`) | 400 | `VALIDATION_ERROR` |

Never return graph payload with a `knowledgeVersionId` that is not the project's current one.

### 4.6 Security

- No secrets, tokens, or full source bodies in responses or logs.
- Path-like fields in DTOs are project-relative paths only; no filesystem roots.
- Parameterized repository queries only; `orgId` from JWT/principal, never from body.

## 5. Data model changes

**None** if phase 28 already stores `KnowledgeVersion` and project `currentKnowledgeVersionId`.

Optional additive fields on `knowledgeVersions` (only if phase 28 left them out):

| Field | Purpose |
|---|---|
| `browseCacheVersion` | Opaque string bumped on publish so FE can invalidate explorer queries |

Confirm against phase 28 schema before a second pass. Row `status: 'A'|'D'` unchanged.

Indexes: reuse phase 26 `{ orgId, projectId, sourceVersionId, path }` on `documentSections` for
doc facets.

## 6. API contract — PROPOSED (needs approval before implementation)

Base path: `/api/v1/projects/:projectId/knowledge`. All routes: **Auth** JWT; **Permission**
`knowledge.browse` or `knowledge.view` (confirm equivalence); project membership required.

### `GET /api/v1/projects/:projectId/knowledge`

- **Query:** `cursor?` (opaque keyset)
- **Response `200`:**

```json
{
  "knowledgeVersionId": "01J...",
  "knowledgeHealth": "ready",
  "facets": [
    { "key": "summary", "available": true },
    { "key": "workflows", "available": true },
    { "key": "apis", "available": false },
    { "key": "symbols", "available": true },
    { "key": "documentation", "available": true }
  ],
  "partialKnowledge": {
    "excludedFromGraphCount": 0,
    "message": null
  },
  "cursor": null
}
```

- **Response `503`:** `{ "error": { "code": "KNOWLEDGE_UNAVAILABLE", ... } }`

### `GET /api/v1/projects/:projectId/knowledge/summary`

- **Response `200`:**

```json
{
  "knowledgeVersionId": "01J...",
  "title": "payments-service",
  "summary": "Bounded plain-text summary derived from docs + graph metadata.",
  "capabilities": [
    { "id": "cap_checkout", "title": "Checkout", "sourceRefs": [{ "path": "src/checkout/", "kind": "code" }] }
  ]
}
```

### `GET /api/v1/projects/:projectId/knowledge/workflows`

- **Query:** `cursor?`, `limit?` (capped by `KNOWLEDGE_BROWSE_PAGE_SIZE`)
- **Response `200`:** `{ "items": [{ "id", "title", "description?", "sourceRefs": [] }], "cursor": null }`

### `GET /api/v1/projects/:projectId/knowledge/apis`

- Same pagination shape as workflows; items describe routes/handlers when CodeGraph provides them.

### `GET /api/v1/projects/:projectId/knowledge/symbols`

- **Query:** `q` (required), `cursor?`, `limit?`
- **Response `200`:**

```json
{
  "items": [
    {
      "id": "sym_refundHandler",
      "name": "refundHandler",
      "kind": "function",
      "path": "src/payments/refund.js",
      "line": 42,
      "sourceRef": { "path": "src/payments/refund.js", "startLine": 42, "endLine": 88 }
    }
  ],
  "cursor": null
}
```

### `GET /api/v1/projects/:projectId/knowledge/health`

- **Response `200`:**

```json
{
  "knowledgeHealth": "ready",
  "lifecycleStatus": "knowledge_ready",
  "knowledgeVersionId": "01J...",
  "dimensions": {
    "sourceCode": { "state": "good", "detail": null },
    "documentation": { "state": "good", "detail": null },
    "projectKnowledge": { "state": "good", "detail": null },
    "staleItems": { "count": 0 }
  },
  "partialKnowledge": {
    "excludedFromGraphCount": 3,
    "userMessage": "3 files are not in the code map; answers may be incomplete."
  }
}
```

Enum values for `state` and `knowledgeHealth` must match phase 28 / data-model mapping — do
not invent a fourth scheme (see section 12).

**Errors (all routes):** `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT FOUND` (cross-tenant),
`400 VALIDATION_ERROR`, `503 KNOWLEDGE_UNAVAILABLE`.

## 7. Configuration & environment variables

**None.** Page sizes, minimum symbol query length, and summary byte caps are named constants in
`modules/knowledge/`.

| Constant | Proposed value | Where | Purpose |
|---|---|---|---|
| `KNOWLEDGE_BROWSE_PAGE_SIZE` | `50` | `knowledge.constants.js` | Default page size for list routes |
| `KNOWLEDGE_SYMBOL_QUERY_MIN_LEN` | `2` | `knowledge.constants.js` | Reject overly broad symbol scans |
| `KNOWLEDGE_SUMMARY_MAX_CHARS` | `4000` | `knowledge.constants.js` | Cap generated summary text |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/knowledge/index.js` | Public surface |
| `backend/src/modules/knowledge/knowledge.routes.js` (+ `.test.js`) | Fastify routes |
| `backend/src/modules/knowledge/knowledge.schemas.js` | Request/response validation |
| `backend/src/modules/knowledge/knowledge.service.js` (+ `.test.js`) | Orchestration, gate, lease |
| `backend/src/modules/knowledge/knowledge.repository.js` (+ `.test.js`) | Document sections, version lookup |
| `backend/src/modules/knowledge/knowledge.mapper.js` (+ `.test.js`) | DTO mapping |
| `backend/src/modules/knowledge/knowledge.constants.js` | Page size and caps |
| `backend/src/modules/codegraph/` (phase 27) | **Use** read-lease helpers from adapter — no duplicate lock logic |
| `backend/src/modules/projects/` (phase 28) | **Use** `assertKnowledgeReadable` — add there if missing |
| `backend/src/http/routes.js` | Register `knowledgeRoutes` |
| `backend/src/platform/errorCatalog.js` | Only if new codes needed beyond `KNOWLEDGE_UNAVAILABLE` |

## 9. Tests (≥ 80% line and branch)

### Unit

- Mapper produces facet lists that omit empty categories (FE §71 rule).
- Symbol route rejects missing/short `q`.
- Service refuses browse when health is `updating` without acquiring CodeGraph.
- Cross-tenant project id → repository returns null → `404`.

### Integration (Fastify `app.inject` + Mongo harness)

- Ready project: summary + symbols return `200` with `knowledgeVersionId` matching project.
- Simulated writer lock held → `503 KNOWLEDGE_UNAVAILABLE`, no graph payload.
- `partially_available` project returns items plus `partialKnowledge.excludedFromGraphCount > 0`.
- Soft-deleted project → `404`.

### Unhappy paths

- Caller lacks `knowledge.browse` and `knowledge.view` → `403`.
- Historical version id in query (if ever added by mistake) → ignored or `400` — document chosen
  behaviour in tests once approved.

## 10. Definition of Done

- [ ] All six solution §11.1 routes are registered under `/api/v1`.
- [ ] Every route enforces org/project scope and RBAC independently of the UI.
- [ ] Browse never returns data from a non-current knowledge version or a stale mid-update graph.
- [ ] `KNOWLEDGE_UNAVAILABLE` is used when the gate or read lease blocks graph reads.
- [ ] List endpoints paginate; constants live in module code, not `.env`.
- [ ] No embeddings/vector/reranker code paths.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch on touched modules.

## 11. Documentation & ADR updates

- `docs/architecture.md` §8: confirm browse route list matches implementation.
- `docs/permissions.md`: no change expected (`knowledge.browse`, `knowledge.view` already cataloged).
- Update `docs/data-model.md` only if §5 adds fields.

## 12. Risks & open questions

1. **`knowledge.browse` vs `knowledge.view`:** Are both required on every route, or is `view`
   sufficient for read-only summary/health?
2. **CodeGraph facet coverage:** Which of workflows/apis/symbols does `@colbymchenry/codegraph`
   actually list at MVP? The explorer must not show empty top-level categories — should `GET
   /knowledge` drive the FE tree entirely?
3. **Unavailable HTTP shape:** Is `503` with `KNOWLEDGE_UNAVAILABLE` correct for browse during
   updates, or should graph routes return `200` with `{ "state": "updating" }` and empty items
   (frontend loading UX)?
4. **`knowledgeHealth` enum mapping:** data-model vs solution naming (`partial` vs
   `partially_available`) — phase 28 must lock this before browse maps health dimensions.
5. **Summary generation:** Is summary extractive from docs/graph metadata only, or deferred until
   an LLM pass exists? Requirements §130 imply structured fields, not generative prose.
6. **Read lease timeout:** Should browse share the same lease TTL as chat tools (phase 46), and
   what happens on lease expiry mid-request?
