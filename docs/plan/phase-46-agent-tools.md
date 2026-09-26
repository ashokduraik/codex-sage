# Phase 46 — Agent tools

- **Layer:** BE
- **Depends on:** Phase 26 (workspace, `DocumentSection`, Mongo FTS), Phase 27 (CodeGraph adapter,
  read lease), Phase 39 (file slice helper), Phase 43 (context budgeter, tokenizer parity)
- **Unblocks:** Phase 48
- **Size:** 1–2 days
- **Requirements covered:** backend §22, §57, §133; backend/solution.md §5.5; docs/architecture.md
  §6.2 (tool table), §7 (read lease), §8 (same tenant isolation as chat)

## 1. Goal

After this phase the Q&A engine has six **scoped, deterministic** tools the LangGraph loop can call:
`explore_code`, `search_documents`, `list_documents`, `read_document_slice`, `read_file_slice`, and
`abstain`. Each tool receives an explicit tenant scope (`orgId`, `projectId`,
`currentKnowledgeVersionId`) and refuses stale, cross-project, unlocated, or oversized results before
anything enters graph state. Code paths acquire a project **read lease** (phase 27) and release it in
`finally`; document paths query only active rows (`status: 'A'`) for the current knowledge version
via `KnowledgeVersion.sourceVersionId`. Accepted snippets pass through Phase 43 `prepareModelInput`
so tool output never bypasses token accounting.
You can see it working in unit/integration tests: a fixture project with materialized docs and a
mock graph returns ranked evidence records; a forged `projectId` or wrong `knowledgeVersionId` fails
closed with no data leakage.

## 2. Why this phase is here

Solution §5.2 node C executes tools in Node — not in the LLM — but nothing implements those calls
yet. Phase 48 owns the **loop** (model chooses tool → execute → append evidence); this phase owns the
**tool surface** so the loop does not embed Mongo, GridFS, and CodeGraph details inline. It must follow
phases 26 and 27 because document search reads `DocumentSection` rows and code exploration reads the
current graph on the materialized workspace. It must follow phase 43 because every tool result is
measured and trimmed before it becomes prompt input (backend §70, solution §5.3). It cannot wait until
phase 48: without tested tools, the graph node has nothing real to invoke and budget tests have no
fixture.

## 3. Scope

### In scope

- A single registry mapping tool name → async executor; only the six MVP tools above (solution §5.5,
  architecture §6.2). No aliases, no plugin discovery in this phase.
- `ToolExecutionScope` built once at run start from the authenticated project row — never from raw
  client fields alone (backend §114).
- Per-tool validation: path normalisation, tenant/version match, max byte/line caps (caps as **named
  constants** reused from preview and search).
- `explore_code`: CodeGraph adapter (27), read lease, bounded `buildContext` (library method when
  present, else `querySymbols` / `queryApis`), convert hits to **evidence records** with run-scoped
  `ev_01…` ids for VERIFY (phase 49).
- `search_documents`: Mongo text search on `DocumentSection` for the current version’s
  `sourceVersionId`; ranked section hits with path, heading, line range, excerpt.
- `list_documents`: paginated Markdown/MDX/text paths (metadata only — no full bodies). Graph-excluded
  docs are included and labeled `excludedFromGraph` (architecture §7).
- `read_document_slice` / `read_file_slice`: bounded GridFS reads via Phase 39 `loadSourceFileSlice`
  (same 64 KiB / 400-line caps as `GET …/files/slice`).
- `abstain`: structured stop signal (reason code + user-safe message); no Mongo/CodeGraph call.
- Rejection helpers: cross-project id, wrong `knowledgeVersionId`, path escape, result over byte cap,
  graph health not readable (phase 28 gate semantics).
- Output: `{ evidenceRecords[], rejected[], usage: { resultBytes, promptTokensAfterBudget }, stop? }`.

### Out of scope (owner phase)

- LangGraph nodes, tool-choice LLM calls, run budgets — **phase 48**.
- HTTP routes (chat SSE, preview) — **phases 39, 50**.
- Live customer DB query tools, shell, web fetch, cross-project search — README §5 / backend §71+.
- Embedding or vector retrieval — README §5.
- Persisting assistant messages or `evidence[]` on `Message` — **phase 49**.
- Source-access audit — **phase 61**.

## 4. Design

### 4.1 Module layout

Tools are a **conversation** resource. Do **not** add `modules/chat/`, `modules/codegraph/`, or
`modules/context/`.

```text
backend/src/modules/conversation/
├── agentTools.js            registry, scope, six executors, evidence ids, budgeter
├── agentTools.helper.js     overflow only after 1000 code lines
├── contextBudgeter.js       prepareModelInput (phase 43)
└── index.js                 executeTool, buildToolExecutionScope, listToolDefinitionsForSchema

backend/tests/modules/conversation/   agentTools*.test.js
```

Conversation imports knowledge **only** through `modules/knowledge/index.js`. Handlers **return data
or throw** `ApiError`; they never write HTTP responses.

### 4.2 Scope enforcement (every tool)

```text
ToolExecutionScope
├── orgId
├── projectId
├── knowledgeVersionId      ← project.currentKnowledgeVersionId at run start
├── sourceVersionId         ← KnowledgeVersion.sourceVersionId (Mongo join key)
├── workspacePath           ← WORKSPACE_ROOT / orgId / projectId
├── correlationId
├── abortSignal             ← client disconnect / run cancel (phase 50)
└── nextEvidenceSeq         ← mints ev_01, ev_02, …
```

Before any query:

1. Load project with `status: 'A'`, matching `orgId`, `knowledgeVersionId` still current (or reject
   as `stale_knowledge_version` / `scope_mismatch`).
2. For graph tools: call phase 28 `assertKnowledgeReadable` + acquire read lease (27).
3. For Mongo: every filter includes `orgId`, `projectId`, `sourceVersionId`, and `status: 'A'`.

### 4.3 Tool behaviours (summary)

| Tool | Input (conceptual) | Backing | LLM? |
|------|-------------------|---------|------|
| `explore_code` | query string, optional symbol/path hints | CodeGraph read lease | No |
| `search_documents` | query string, optional path prefix | Mongo FTS on sections | No |
| `list_documents` | cursor, page size | SourceFile doc paths | No |
| `read_document_slice` | path, heading or start/end line | GridFS via `loadSourceFileSlice` | No |
| `read_file_slice` | path, start/end line | GridFS via `loadSourceFileSlice` | No |
| `abstain` | reason code, message | Node only | No |

Model-facing JSON schemas for arguments are built from the same registry (phase 48 passes them to the
tool-choice prompt). Schemas list only these names — no extensibility hook in MVP.

### 4.4 Evidence records and budgeter

Each accepted hit becomes an `EvidenceRecord`:

```text
EvidenceRecord
├── evidenceId          run-scoped ev_01, ev_02, …
├── kind                'code' | 'document' | 'config'
├── path, startLine?, endLine?, heading?
├── excerpt             bounded text (never full file)
├── knowledgeVersionId
├── sourceVersionId?    when known from row
├── provenance          { toolName, graphQuery? | sectionId? }
└── excludedFromGraph?  list/read metadata only
```

After raw assembly, map hits to `tool_result` / `excerpt` segments and call `prepareModelInput`
(phase 43). Compaction drops or truncates excerpts in rank order. Dropped items append to
`rejected[]` with a reason code for logs, not for the UI.

### 4.5 Failure handling

| Condition | Tool outcome |
|-----------|----------------|
| Graph updating / no lease | Throw `KNOWLEDGE_UPDATING` or `KNOWLEDGE_UNAVAILABLE` (phase 28) |
| Path not found / not in version | Empty result or `not_found` reject; never invent content |
| Excerpt over cap | Truncate at natural boundary or reject with `oversized_result` |
| AbortSignal fired | Abort in-flight read; propagate `AbortError` to caller |

No tool logs raw file bodies or tokens (backend §149).

## 5. Data model changes

**None.** Tools read existing collections (`documentSections`, `sourceFiles`, `knowledgeVersions`,
projects) and the on-disk workspace. Evidence ids exist only in graph run state until phase 49 persists
them on `Message`. This phase does not write `Message.evidence`.

## 6. API contract — approved (internal; no HTTP)

**No HTTP surface in this phase.** Internal contract for phase 48:

```json
{
  "executeTool": {
    "name": "explore_code | search_documents | list_documents | read_document_slice | read_file_slice | abstain",
    "args": "object — per-tool JSON schema",
    "scope": "ToolExecutionScope",
    "budgetState": "mutable run budget snapshot from phase 48"
  },
  "toolResult": {
    "evidenceRecords": "EvidenceRecord[]",
    "rejected": [{ "code": "string", "message": "string" }],
    "usage": { "resultBytes": "number", "promptTokensAfterBudget": "number" },
    "stop": "{ reasonCode, message } — abstain only"
  },
  "toolDefinition": {
    "name": "string",
    "description": "string — safe for tool-schema prompt",
    "parameters": "JSON Schema object"
  }
}
```

Abstain `args`:

```json
{ "reasonCode": "insufficient_scope | user_requested | no_support", "message": "user-safe string" }
```

Unknown tool name throws `TOOL_UNKNOWN`.

## 7. Configuration & environment variables

**None.** Caps are named constants already locked by earlier phases:

| Constant | Value | Owner |
|---|---|---|
| `SOURCE_PREVIEW_MAX_BYTES` | 65_536 | `knowledge/sourcePreview.js` |
| `SOURCE_PREVIEW_MAX_LINES` | 400 | same |
| `SEARCH_DOC_MAX_RESULTS` | 15 | `knowledge/search.js` |
| `SEARCH_GRAPH_MAX_RESULTS` | 15 | same |
| `SEARCH_SNIPPET_MAX_CHARS` | 280 | same |
| `LIST_DOCUMENTS_PAGE_SIZE` | 20 | `conversation/agentTools.js` |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/conversation/agentTools.js` | Registry, scope, six tools, evidence ids, budgeter |
| `backend/src/modules/conversation/index.js` | Export `executeTool`, `buildToolExecutionScope`, `listToolDefinitionsForSchema` |
| `backend/src/modules/knowledge/index.js` | Re-export only the helpers tools import |
| `backend/src/modules/knowledge/documents.js` | `listDocumentFilesForVersion`; FTS `pathPrefix` |
| `backend/src/modules/knowledge/codegraph.js` | Implement `buildContext` on an existing lease graph |
| `backend/src/platform/errorCatalog.js` | `TOOL_UNKNOWN` |
| `backend/tests/modules/conversation/agentTools.test.js` | Unit coverage |
| `backend/tests/modules/conversation/agentTools.integration.test.js` | Tenant isolation + slice |

## 9. Tests (≥ 80% line and branch)

### Unit

- Registry lists exactly six tools; unknown name throws `TOOL_UNKNOWN`.
- Scope rejects when `knowledgeVersionId` ≠ project current; rejects forged `orgId`.
- Path `../etc/passwd` and absolute paths fail closed on slice reads.
- `search_documents` query always includes tenant + `sourceVersionId` + `status: 'A'` filters.
- `explore_code` acquires and releases read lease even when adapter throws.
- Budgeter integration: oversized mock result truncates or drops with documented order.
- `abstain` returns zero evidence records and a structured stop payload.

### Integration (Mongo + workspace fixtures from phases 26/03 harness)

- Fixture project: search returns only that project's sections; second org sees nothing.
- `read_file_slice` returns correct line range; over-range clamped or rejected per preview caps.
- Graph tool with lease held: release on success and on failure.

### Unhappy paths

- Graph unavailable → `KNOWLEDGE_UNAVAILABLE` or `KNOWLEDGE_UPDATING`.
- Abort mid-read → partial result not appended; lease released.
- Empty FTS → `{ evidenceRecords: [] }`, not an error.

## 10. Definition of Done

- [x] Six tools implemented; no seventh tool name registered.
- [x] Every tool enforces `orgId + projectId + currentKnowledgeVersionId + status: 'A'`.
- [x] CodeGraph path uses read lease from phase 27; no writer lock bypass.
- [x] No live DB/shell/web/cross-project tools exist in the registry.
- [x] Tool results pass through phase 43 `prepareModelInput` before returning to callers.
- [x] Evidence records include `ev_NN` ids and `knowledgeVersionId` for phase 49 VERIFY.
- [x] No HTTP routes added; no assistant `Message` writes.
- [x] No new `.env` keys; caps reuse locked preview/search constants.
- [x] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch on new modules.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.2: six names unchanged; evidence ids `ev_01…`; slices reuse preview helper.
- `backend/solution.md` §5.5: tenant key is `orgId`.
- Phase 48 consume path points at `conversation` `executeTool`.
- No new ADR.

## 12. Risks & open questions

Closed in the Phase 46 implementation conversation:

1. **Numeric caps** — reuse Phase 39 preview caps and Phase 38 search limits (see §7).
2. **Shared slice reader** — reuse `loadSourceFileSlice` (Phase 39 already landed).
3. **Partial knowledge** — `list_documents` includes graph-excluded docs with `excludedFromGraph`.
4. **Evidence id format** — run-scoped `ev_01`, `ev_02`, … (not search-style ids).
5. **Tool audit** — deferred to Phase 61.
