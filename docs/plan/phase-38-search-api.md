# Phase 38 — Project search API & "ask about this" resolution

- **Layer:** BE
- **Depends on:** Phase 26 (`DocumentSection` + Mongo text index), Phase 28 (published knowledge,
  current version, Q&A gate)
- **Unblocks:** Phase 40, 50 (resolution function for attached search context)
- **Size:** 1–2 days
- **Requirements covered:** backend §131, §132; solution §11.2; arch §7–§8;
  `docs/permissions.md` (`search.run`)

## 1. Goal

After this phase authorized users can run **project-scoped keyword search** over code symbols,
workflows, and documentation through one HTTP endpoint. Results are typed, located, and tied to
the **current** `knowledgeVersionId` with inspectable source references. A separate **internal
resolution function** (not necessarily its own route) re-fetches a result by id under the same
tenant/version scope so phase 50 can turn "ask about this" attachments into bounded evidence
before UNDERSTAND. Search never uses embeddings, vectors, or rerankers. During graph
update/recovery, code-side search follows the same **unavailable** rules as browse (phase 37) —
no stale graph results.

## 2. Why this phase is here

Frontend §72 needs real search results with Open / Ask about this actions; phase 26 builds the
document FTS index and phase 28 publishes the graph version search must anchor to. Browse (phase
37) is navigational; search is **retrieval by query**. Chat integration (backend §132) is not a
second user-facing search UI — it is **re-resolution** of selected hits when a message is
composed (architecture §8). This phase must land before phase 40 rewires `SearchPanel.jsx` and
before phase 50 implements message attachments, but it must not implement SSE or LLM calls.

## 3. Scope

### In scope

- `GET /api/v1/projects/:projectId/search` (solution §11.2).
- Permission `search.run` + project membership; tenant scope `orgId + projectId + status: 'A'`;
  cross-tenant → `404 NOT_FOUND`.
- Query params: `q` (required), `types` (filter), `cursor` (keyset pagination).
- Retrieval:
  - **code**, **symbol**, **workflow** (and **api** if aligned with FE §72) via bounded
    CodeGraph queries under read lease (phase 27), same gate as phase 37.
  - **doc** via Mongo `$text` / text index on `documentSections` scoped to current source
    version.
- Unified result envelope with stable `id`, `type`, `title`, `snippet`, `sourceRef`,
  `knowledgeVersionId`.
- **`resolveSearchResultForChat({ orgId, projectId, resultId, knowledgeVersionId })`** exported
  from the module public surface for phase 50 — converts a stored attachment id back to evidence
  slices under budget (implementation of budgeter interaction is phase 43/50; this phase returns
  raw resolved evidence shapes).
- No in-app rate limiting (architecture §10).

### Out of scope (owner phase)

- Knowledge explorer tree routes — **phase 37**.
- File byte preview / line slices — **phase 39**.
- `POST` chat message or SSE — **phase 50**.
- **`POST /search/ask` or any dedicated "ask" route** — do not invent; see section 12.
- Usage rollups — **phase 59** (may emit a single `UsageEvent` stub if hook exists).
- Cross-project search — **README §5**.
- Embeddings / vector / reranker — **README §5**.

## 4. Design

### 4.1 Search pipeline

```text
JWT + search.run + project ACL
  → load project + assertKnowledgeReadable (phase 28)
  → parse types[] default: code,doc,symbol,workflow
  → parallel bounded retrieval:
        docSearch(q)     → Mongo FTS, limit DOC cap
        graphSearch(q)   → read lease → CodeGraph bounded query, limit GRAPH cap
  → merge, stable-sort (type order then relevance rank — rank algorithm open in §12)
  → assign ids: `${knowledgeVersionId}:${type}:${opaqueKey}`
  → page with keyset cursor
  → return { items, cursor, knowledgeVersionId }
```

If the read lease cannot be acquired, **omit graph-backed types** or fail the whole request —
do not pick silently; see section 12.

### 4.2 Type filter mapping

| `types` token | Source | FE §72 label (i18n key TBD) |
|---|---|---|
| `code` | CodeGraph file/symbol hits | Code |
| `doc` | DocumentSection FTS | Documentation |
| `symbol` | CodeGraph symbol index | Functionality / Code |
| `workflow` | CodeGraph workflow nodes | Workflows |
| `api` | CodeGraph route/API entries | APIs |

**Data** and live-DB entity hits are **out of MVP** (frontend §72 "Data" must not appear unless
backend returns `type: 'data'` from a real detector — none in this phase).

### 4.3 Result identity and chat handoff (backend §132, architecture §8)

Each item includes:

```text
id            stable for current knowledgeVersionId
type          enum
title         display string
snippet       bounded plain text (no secrets)
sourceRef     { path, startLine?, endLine?, sectionId? }
score         optional number for sort only — may omit if no honest rank
```

Phase 40 passes `id` + `knowledgeVersionId` into the chat composer context (query param or
composer state — FE decision). Phase 50 calls **`resolveSearchResultForChat`** before UNDERSTAND
to re-fetch under `orgId + projectId + current version` so stale attachments after a publish fail
closed with `KNOWLEDGE_UNAVAILABLE` or attachment invalidation — exact behaviour in section 12.

### 4.4 Current graph and documents only

- Search never accepts `knowledgeVersionId` from the client; always uses project current.
- Historical graph ids are not queryable (README §5).
- Document FTS only indexes sections for the source version linked to the current knowledge
  version.

### 4.5 Honesty constraints

- No fabricated relevance scores: if CodeGraph/Mongo do not provide ranking, sort lexically or
  by type only and omit `score`.
- Snippets are truncated with named constants; never return entire large files.

## 5. Data model changes

**None** expected. Search reads `documentSections` (phase 26) and project/knowledge metadata
(phase 28). Optional: text index already on sections — confirm name and weights in phase 26
before duplicating indexes.

## 6. API contract — PROPOSED (needs approval before implementation)

### `GET /api/v1/projects/:projectId/search`

- **Auth:** JWT
- **Permission:** `search.run` + project membership
- **Query:**

| Param | Required | Description |
|---|---|---|
| `q` | yes | Search string; min length `SEARCH_QUERY_MIN_LEN` |
| `types` | no | Comma-separated subset of `code,doc,symbol,workflow,api`; default all except `api` if unsupported |
| `cursor` | no | Opaque keyset |
| `limit` | no | Capped at `SEARCH_PAGE_SIZE` |

- **Response `200`:**

```json
{
  "knowledgeVersionId": "01J...",
  "q": "refund",
  "items": [
    {
      "id": "01J...:symbol:sym_refundHandler",
      "type": "symbol",
      "title": "refundHandler",
      "snippet": "async function refundHandler(orderId, amount) {",
      "sourceRef": {
        "path": "src/payments/refund.js",
        "startLine": 42,
        "endLine": 45
      },
      "score": null
    },
    {
      "id": "01J...:doc:sec_refund_policy",
      "type": "doc",
      "title": "Refund policy",
      "snippet": "Partial refunds are allowed within 30 days…",
      "sourceRef": {
        "path": "docs/refunds.md",
        "sectionId": "01J..."
      },
      "score": null
    }
  ],
  "cursor": null
}
```

- **Response `503`:** `KNOWLEDGE_UNAVAILABLE` when gate blocks all requested graph types.
- **Errors:** `400 VALIDATION_ERROR` (missing `q`, unknown `types`), `401`, `403`, `404`.

### Internal: `resolveSearchResultForChat` (not HTTP unless approved in §12)

```text
resolveSearchResultForChat({
  orgId, projectId, resultId, expectedKnowledgeVersionId?
}) → Promise<{
  ok: true,
  evidence: { type, title, sourceRef, excerpt }
} | {
  ok: false,
  code: 'KNOWLEDGE_UNAVAILABLE' | 'SEARCH_RESULT_NOT_FOUND'
}>
```

**No `POST /api/v1/projects/:projectId/search/ask`** unless product explicitly approves a
separate route in section 12.

## 7. Configuration & environment variables

**None.**

| Constant | Proposed value | Where | Purpose |
|---|---|---|---|
| `SEARCH_QUERY_MIN_LEN` | `2` | `search.constants.js` | Avoid full-table scan on single char |
| `SEARCH_PAGE_SIZE` | `25` | `search.constants.js` | Default page size |
| `SEARCH_SNIPPET_MAX_CHARS` | `280` | `search.constants.js` | Result snippet cap |
| `SEARCH_GRAPH_MAX_RESULTS` | `15` | `search.constants.js` | Per-type graph cap before merge |
| `SEARCH_DOC_MAX_RESULTS` | `15` | `search.constants.js` | FTS cap before merge |

Result **count cap** for product "evaluation" (missing plan Part I) stays open — constants above
are placeholders until phase 05/benchmark confirms.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/search/index.js` | Public surface incl. resolver export |
| `backend/src/modules/search/search.routes.js` (+ `.test.js`) | HTTP route |
| `backend/src/modules/search/search.schemas.js` | Validation |
| `backend/src/modules/search/search.service.js` (+ `.test.js`) | Merge, gate, lease |
| `backend/src/modules/search/search.repository.js` (+ `.test.js`) | FTS queries |
| `backend/src/modules/search/search.resolver.js` (+ `.test.js`) | `resolveSearchResultForChat` |
| `backend/src/modules/search/search.constants.js` | Caps |
| `backend/src/modules/knowledge/knowledge.service.js` | **Reuse** gate/lease helpers from phase 37 if extracted to shared platform — prefer thin wrapper over duplication |
| `backend/src/http/routes.js` | Register search routes |

## 9. Tests (≥ 80% line and branch)

### Unit

- Type filter parsing: unknown token → `400`.
- Id format encodes version + type; parser round-trips in resolver.
- Resolver returns `SEARCH_RESULT_NOT_FOUND` for wrong org/project.
- Resolver rejects id from older knowledge version when `expectedKnowledgeVersionId` mismatches.

### Integration

- Seed project with doc sections + graph fixture: search returns both doc and symbol hits.
- Writer lock held → graph types unavailable (`503` or empty graph items — match approved §12).
- Cross-tenant project → `404`.
- Missing `search.run` → `403`.

### Unhappy paths

- Empty `q`, whitespace-only `q` → `400`.
- `types=doc` only while graph updating still returns doc hits if gate allows docs-only.

## 10. Definition of Done

- [ ] `GET .../search` implemented with PROPOSED contract approved.
- [ ] Results include `knowledgeVersionId` and stable `id` values.
- [ ] No vector/embedding/reranker usage.
- [ ] `resolveSearchResultForChat` exported and tested; no unapproved `/search/ask` route.
- [ ] Tenant isolation and RBAC enforced on every call.
- [ ] Constants in module code; no new `.env` keys.
- [ ] Coverage ≥ 80% line and branch; lint and tests green.

## 11. Documentation & ADR updates

- `docs/architecture.md` §8: document search + resolver handoff to phase 50.
- `backend/solution.md` §11.2: update only if implementation diverges after approval.

## 12. Risks & open questions

1. **Dedicated POST for "ask about this"?** Backend §132 implies passing selected results into
   conversation context. Is **`resolveSearchResultForChat` inside phase 50's message POST**
   sufficient, or does product require `POST /search/ask`? Do not implement a route until
   answered.
2. **Graph unavailable behaviour:** When the lease fails, should search return docs-only `200` or
   all-or-nothing `503`?
3. **Relevance ranking:** Mongo text score + CodeGraph order — is any merged ranking honest enough
   to expose as `score`, or should sort be type-then-title only?
4. **FE type labels:** Map `symbol` → "Functionality" vs "Code" (frontend §72) — confirm i18n
   keys in phase 40.
5. **Result size cap:** Final caps depend on evaluation (phase 05 unwritten) and context budget
   (phase 43); are the PROPOSED constants acceptable interim values?
6. **Attachment invalidation after publish:** Should phase 50 reject sends with outdated result
   ids automatically, or should search ids survive across versions when path/hash unchanged?
