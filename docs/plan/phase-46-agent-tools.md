# Phase 46 — Agent tools

- **Layer:** BE
- **Depends on:** Phase 26 (workspace, `DocumentSection`, Mongo FTS), Phase 27 (CodeGraph adapter,
  read lease), Phase 43 (context budgeter, tokenizer parity)
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
`finally`; document paths query only active rows (`status: 'A'`) for the current knowledge version.
Accepted snippets pass through the phase 43 budgeter so tool output never bypasses token accounting.
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
  constants**; numeric values that depend on evaluation stay open — see §12).
- `explore_code`: CodeGraph adapter (27), read lease, bounded `buildContext` / explore, convert hits
  to **evidence records** with stable ids for VERIFY (phase 49).
- `search_documents`: Mongo text search on `DocumentSection` for current version; ranked section
  hits with path, heading, line range, excerpt.
- `list_documents`: paginated paths for Markdown/MDX/text (and metadata only — no full bodies).
- `read_document_slice` / `read_file_slice`: bounded reads from materialized workspace or GridFS
  (same caps as preview — phase 39 may own HTTP; tools reuse the same read helper when it exists, or
  a shared internal slice reader introduced here).
- `abstain`: structured stop signal (reason code + user-safe message); no Mongo/CodeGraph call.
- Rejection helpers: cross-project id, wrong `knowledgeVersionId`, path escape, result over byte cap,
  graph health not readable (delegate to phase 28 gate semantics where applicable).
- Output: `{ evidenceRecords[], rejected[], usage: { resultBytes, promptTokensAfterBudget } }`.

### Out of scope (owner phase)

- LangGraph nodes, tool-choice LLM calls, run budgets — **phase 48**.
- HTTP routes (chat SSE, preview) — **phases 39, 50**.
- Live customer DB query tools, shell, web fetch, cross-project search — README §5 / backend §71+.
- Embedding or vector retrieval — README §5.
- Persisting assistant messages or `evidence[]` on `Message` — **phase 49**.

## 4. Design

### 4.1 Module layout

New module `backend/src/modules/chat/tools/` (public surface via `modules/chat/index.js` once the
chat module exists; until then `modules/chat/tools/index.js` exports registry + scope factory).

```text
tools/
├── index.js                 registerTool, executeTool, listToolDefinitionsForSchema
├── toolScope.js             buildToolExecutionScope from runContext + project row
├── toolEvidence.js          evidence id assignment, normalised EvidenceRecord shape
├── toolReject.js            stale / oversize / scope violations → ToolRejectReason
├── exploreCode.tool.js      read lease + CodeGraph adapter
├── searchDocuments.tool.js  Mongo $text on documentSections
├── listDocuments.tool.js    distinct doc paths, keyset cursor
├── readDocumentSlice.tool.js
├── readFileSlice.tool.js
├── abstain.tool.js
└── shared/
    ├── pathSafety.js        reuse or thin-wrap phase 26 path join rules
    └── sliceReader.js       bounded line/heading reads (shared with preview later)
```

Handlers **return data or throw** `ApiError`; they never write HTTP responses (workspace rule).

### 4.2 Scope enforcement (every tool)

```text
ToolExecutionScope
├── orgId
├── projectId
├── knowledgeVersionId      ← project.currentKnowledgeVersionId at run start
├── workspacePath           ← from KnowledgeVersion / project materialization
├── correlationId
└── abortSignal             ← client disconnect / run cancel (phase 50)
```

Before any query:

1. Load project with `status: 'A'`, matching `orgId`, `knowledgeVersionId` still current (or reject
   as `stale_knowledge_version`).
2. For graph tools: call phase 28 `assertKnowledgeReadable` (or equivalent) + acquire read lease (27).
3. For Mongo: every filter includes `orgId`, `projectId`, `sourceVersionId` or version linkage tied
   to `knowledgeVersionId`, and `status: 'A'`.

### 4.3 Tool behaviours (summary)

| Tool | Input (conceptual) | Backing | LLM? |
|------|-------------------|---------|------|
| `explore_code` | query string, optional symbol/path hints | CodeGraph read lease | No |
| `search_documents` | query string, optional path prefix | Mongo FTS on sections | No |
| `list_documents` | cursor, page size | SourceFile / doc paths | No |
| `read_document_slice` | path, heading or start/end line | Workspace / GridFS | No |
| `read_file_slice` | path, start/end line | Workspace / GridFS | No |
| `abstain` | reason code, message | Node only | No |

Model-facing JSON schemas for arguments are built from the same registry (phase 48 passes them to the
tool-choice prompt). Schemas list only these names — no extensibility hook in MVP.

### 4.4 Evidence records and budgeter

Each accepted hit becomes an `EvidenceRecord`:

```text
EvidenceRecord
├── evidenceId          stable within the run (e.g. ev_01…)
├── kind                'code' | 'document' | 'config'
├── path, startLine?, endLine?, heading?
├── excerpt             bounded text (never full file)
├── knowledgeVersionId
├── sourceVersionId?    when known from row
└── provenance          { toolName, graphQuery? | sectionId? }
```

After raw assembly, `applyToolResultBudget(records, budgetState)` (phase 43) drops or truncates
excerpts in rank order until `resultBytes` and projected prompt tokens fit the **remaining run
budget** (budget totals configured in phase 48 — values open until phase 05). Rejected items append
to `rejected[]` with a reason code for logs, not for the UI.

### 4.5 Failure handling

| Condition | Tool outcome |
|-----------|----------------|
| Graph updating / no lease | Throw `KNOWLEDGE_UNAVAILABLE` (temporary) or structured reject — align with phase 28 gate |
| Path not found / not in version | Empty result or `user`-class reject; never invent content |
| Excerpt over cap | Truncate at natural boundary or reject with `oversized_result` |
| AbortSignal fired | Abort in-flight read; propagate `AbortError` to caller |

No tool logs raw file bodies or tokens (backend §149).

## 5. Data model changes

**None.** Tools read existing collections (`documentSections`, `sourceFiles`, `knowledgeVersions`,
projects) and the on-disk workspace. Evidence ids exist only in graph run state until phase 49 persists
them on `Message`.

If phase 41's `Message` schema already defines `evidence[]`, this phase does not write it — only
matches the shape expected in phase 49 PROPOSED contract.

## 6. API contract — PROPOSED (needs approval before implementation)

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
    "usage": { "resultBytes": "number", "promptTokensAfterBudget": "number" }
  },
  "toolDefinition": {
    "name": "string",
    "description": "string — safe for tool-schema prompt",
    "parameters": "JSON Schema object"
  }
}
```

Abstain `args` PROPOSED:

```json
{ "reasonCode": "insufficient_scope | user_requested | no_support", "message": "user-safe string" }
```

## 7. Configuration & environment variables

**None.** Slice byte cap, max lines per read, FTS result limit, and explore node cap are **named
constants** in the tool module. **Do not invent evaluation-sized numbers** — place constants in code
only after phase 05 locks them; until then use clearly marked placeholder constants in tests only, or
mock caps in tests (see §12).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/chat/tools/index.js` | Registry, `executeTool`, schema export for LLM |
| `backend/src/modules/chat/tools/toolScope.js` (+ `.test.js`) | Scope factory, stale-version checks |
| `backend/src/modules/chat/tools/toolEvidence.js` (+ `.test.js`) | EvidenceRecord builder + ids |
| `backend/src/modules/chat/tools/toolReject.js` (+ `.test.js`) | Normalised reject reasons |
| `backend/src/modules/chat/tools/exploreCode.tool.js` (+ `.test.js`) | Read lease + adapter |
| `backend/src/modules/chat/tools/searchDocuments.tool.js` (+ `.test.js`) | FTS queries |
| `backend/src/modules/chat/tools/listDocuments.tool.js` (+ `.test.js`) | Paginated listing |
| `backend/src/modules/chat/tools/readDocumentSlice.tool.js` (+ `.test.js`) | Doc slice reads |
| `backend/src/modules/chat/tools/readFileSlice.tool.js` (+ `.test.js`) | Code/config slice reads |
| `backend/src/modules/chat/tools/abstain.tool.js` (+ `.test.js`) | Stop signal |
| `backend/src/modules/chat/tools/shared/pathSafety.js` | Path join + escape guards |
| `backend/src/modules/chat/tools/shared/sliceReader.js` (+ `.test.js`) | Bounded reads |
| `backend/src/modules/codegraph/` (phase 27) | **Consume only** — no deep imports bypassing public surface |
| `backend/src/modules/context/` (phase 43) | **Consume** budgeter entry used after each tool |

## 9. Tests (≥ 80% line and branch)

### Unit

- Registry lists exactly six tools; unknown name throws catalog error.
- Scope rejects when `knowledgeVersionId` ≠ project current; rejects forged `orgId`.
- Path `../etc/passwd` and absolute paths fail closed on slice reads.
- `search_documents` query always includes tenant + version + `status: 'A'` filters (assert query shape).
- `explore_code` acquires and releases read lease even when adapter throws.
- Budgeter integration: oversized mock result truncates or drops with documented order.
- `abstain` returns zero evidence records and a structured stop payload.

### Integration (Mongo + workspace fixtures from phases 26/03 harness)

- Fixture project: search returns only that project's sections; second org sees nothing.
- `read_file_slice` returns correct line range; over-range clamped or rejected per PROPOSED cap policy.
- Graph tool with lease held: concurrent test proves release on success and on failure.

### Unhappy paths

- Graph unavailable → `KNOWLEDGE_UNAVAILABLE` or empty with abstain path (match phase 28 contract).
- Abort mid-read → partial result not appended; lease released.
- Empty FTS → `{ evidenceRecords: [] }`, not an error.

## 10. Definition of Done

- [ ] Six tools implemented; no seventh tool name registered.
- [ ] Every tool enforces `orgId + projectId + currentKnowledgeVersionId + status: 'A'`.
- [ ] CodeGraph path uses read lease from phase 27; no writer lock bypass.
- [ ] No live DB/shell/web/cross-project tools exist in the registry.
- [ ] Tool results pass through phase 43 budgeter before returning to callers.
- [ ] Evidence records include ids and `knowledgeVersionId` for phase 49 VERIFY.
- [ ] No HTTP routes added; no assistant `Message` writes.
- [ ] No new `.env` keys; caps are constants or explicitly deferred to phase 05 (§12).
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch on new modules.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.2: confirm tool names match registry if implementation differs.
- `backend/solution.md` §5.5 remains authoritative.
- No new ADR unless checkpointer or evidence shape disputes arise — prefer aligning with phase 49.

## 12. Risks & open questions

1. **Numeric caps** (max slice bytes, FTS hit count, CodeGraph node limit): blocked on **phase 05**
   evaluation — do not ship production constants guessed in this phase.
2. **Shared slice reader vs phase 39:** should `read_*_slice` tools call the same module as
   `GET .../files/slice`, or duplicate bounded read logic until 39 lands?
3. **Partial knowledge:** when `knowledgeHealth` is `partially_available`, do graph-excluded paths
   still appear in `list_documents` with an exclusion flag (architecture §7)?
4. **Evidence id format:** UUID vs prefixed string — must match phase 49 persistence and FE §61.
5. **Tool audit:** backend §134 optional source-access audit — defer to phase 39/61 or emit from tools
   here?
