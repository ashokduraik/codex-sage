# Solution — MVP Backend

Technical architecture: [`docs/architecture.md`](../docs/architecture.md)  
Requirements: [`backend/requirments.md`](./backend/requirments.md)  
Platform shell: Fastify 5 + Pino + JavaScript
([ADR 0002](../docs/adr/0002-fastify-api-v1.md) /
[ADR 0005](../docs/adr/0005-pino-logging.md) /
[ADR 0000](../docs/adr/0000-plain-javascript.md))

**MVP goal:** Ingest a large **Node.js + MongoDB** target app → current structural code
knowledge plus on-demand Markdown/text access → grounded Q&A, plus org/RBAC admin, audit,
conversation lifecycle, search/knowledge browse, notifications, usage, retention, rate limits,
and idempotency.
**No** live SQL/DB-query path against the *customer* app database (see §14). **No** image ingest in this slice.

**Target app scale (design baseline):** ~**2M lines of code**. CodeGraph currently excludes
individual files larger than **1 MiB**; accepted projects containing those files are explicitly
`partially_available`.

Ingest and Q&A are the heart of the product. Both flows below are normative.

---

## 1. Decisions and evaluation status

| Topic | Decision |
|-------|----------|
| Evaluation chat model | **`qwen3.8:latest`** on Ollama; currently a 27.3B Q4_K_M artifact (~18 GB) |
| Model lock | Not production-pinned; re-evaluate and pin only when implementation begins |
| Effective context | Benchmark 32K / 64K / 128K; configure the largest passing budget |
| Code intelligence | **`@colbymchenry/codegraph` Node library**, current graph only |
| Code retrieval | CodeGraph only; no code embeddings, vector search, or external reranker |
| Documents | Markdown/MDX/text in Mongo; scoped FTS + bounded reads; no embeddings |
| Graph updates | Worker-controlled in-place sync; project Q&A queues while graph is unavailable |
| CodeGraph telemetry | Disabled in every environment |
| LLM client | **Vercel AI SDK (`ai`)** → Ollama OpenAI-compatible API |
| ODM | **Mongoose** for CRUD and domain models |
| Raw bytes | **GridFS** (not LocalStack S3) |
| Jobs | **MongoDB job collection** + worker poller (**no Redis / BullMQ**) |
| Atlas | **Not required.** Local MongoDB **8+** |
| SQL / DB Q&A | **Out of MVP** |
| Images | **Ignored** |
| `node_modules` | **Skip at upload/extract**; else reject and ask re-upload |

These are evaluation decisions, not proof of scale, accuracy, latency, or reliability. Before an
implementation ADR locks them, representative tests must establish CodeGraph coverage and recovery,
Qwen memory/context behavior, tokenizer parity, grounding quality, queue behavior, and safe
concurrency.

### 1.1 Qwen3.8 feasibility and execution

The current `qwen3.8:latest` artifact is reported by Ollama as 27.3B parameters, Q4_K_M,
approximately 18 GB, with an advertised 256K context. The target machine is known only as having
approximately 35 GB of usable inference memory; GPU model, host RAM, CPU, and OS are not known.

The weights appear loadable, but full feasibility is **not proven**: KV cache, runtime buffers,
the multimodal projector, context length, thinking tokens, and concurrent requests require
additional memory. Benchmark 32K, 64K, and 128K on the actual machine and configure the largest
passing context. Record peak memory, time to first token, throughput, OOM behavior, and concurrency.

Use one model for all graph nodes:

- UNDERSTAND, query rewriting, and routine tool selection: thinking disabled.
- DRAFT: bounded thinking enabled.
- VERIFY: run deterministic citation/path/scope checks first; use bounded thinking only when those
  checks cannot decide.

All settings remain configurable until evaluation. Use a bounded inference queue and set the
largest safe concurrency from benchmark results.

```bash
ollama pull qwen3.8
```

The moving `latest` alias is acceptable only for evaluation. Before implementation, pin the tested
artifact and record the model decision in an ADR.

### 1.2 Context budget before every LLM call

Before UNDERSTAND, tool selection, summarization, DRAFT, VERIFY, or title generation, Node assembles
the exact messages and uses the tokenizer matching the active model artifact.

```text
validated context capacity
  - reserved output tokens
  - system and tool-schema tokens
  = maximum input budget

measured input <= maximum input budget  → send
measured input >  maximum input budget  → compact; never send as-is
```

Compaction order:

1. Preserve system/grounding rules, current question, clarification answers, and pinned user facts.
2. Replace older turns with a persisted summary created before the hard limit.
3. Remove lower-ranked CodeGraph results and document excerpts while retaining source identifiers.
4. Reduce oversized excerpts at source boundaries.
5. If the minimum grounded prompt still does not fit, clarify or abstain.

If the tokenizer is unavailable or does not match the active artifact, fail closed with a
structured, retryable `CONTEXT_ACCOUNTING_UNAVAILABLE` error. Do not submit a prompt with unknown
size or expose an estimate as measured usage.

Persist and expose the validated input limit, measured input tokens, reserved output, percentage
used, compaction actions, and provider-reported usage. Enforce configurable cumulative token,
tool-result byte, total-call, and wall-time budgets selected by evaluation. There is no fixed
tool-round cap, but exhausting any budget terminates the run.
---

## 2. Technologies & software

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 26+, JavaScript |
| HTTP | Fastify 5, `/api/v1` |
| Data access | **Mongoose** (schemas, validation, CRUD, middleware) |
| DB | Local MongoDB **8+** (current stable; use latest 8.x) |
| Blobs | GridFS |
| Queue | MongoDB `jobs` collection |
| Orchestration | `@langchain/langgraph` + tool nodes |
| LLM I/O (chat) | **`ai` (Vercel AI SDK)** → Ollama OpenAI-compat (`/v1`) for understand / draft / verify streaming |
| Chat | Evaluation: **`qwen3.8:latest`**; pin the passing artifact before implementation |
| Code graph | **`@colbymchenry/codegraph`** Node library on a tenant/project-isolated workspace |
| Code graph store | Current per-project CodeGraph SQLite index on an encrypted server volume |
| Document retrieval | MongoDB text index + bounded GridFS/source reads for Markdown/MDX/text |
| Embeddings / reranker | **None** |
| Docs parse | `unified` / `remark` for bounded Markdown/MDX sections; plain-text line slices |
| Auth | JWT + argon2 |
| Soft delete | `status: 'A' \| 'D'`; lifecycle in separate fields |

**Software:** Node 24+, MongoDB **8+**, Ollama with the evaluation Qwen artifact, encrypted local
storage for materialized source/CodeGraph indexes, Git optional.

**Packages (indicative):**

```text
fastify @fastify/jwt @fastify/multipart zod
mongoose argon2 jose pino ai @ai-sdk/openai
@langchain/langgraph @langchain/core
@colbymchenry/codegraph adm-zip ignore unified remark-parse
vitest
```

Install the latest stable CodeGraph package only when implementation begins, then record the
resolved version and lockfile. Set `CODEGRAPH_TELEMETRY=0` (and `DO_NOT_TRACK=1` defensively) in
every environment.

### 2.1 Why use npm `ai` (Vercel AI SDK)?

It does **not** make Qwen smarter. Answer quality comes from the evaluated Qwen artifact, scoped
CodeGraph/document tools, context budgeting, and evidence verification.

It **does** improve the product path around the model:

| Benefit | Why it matters here |
|---------|---------------------|
| Reliable token streaming | `streamText` → easier SSE `delta` events to the UI |
| Abort / cancel | Client disconnect maps cleanly to stop generation |
| Usage when reported | Input/output token fields for message metrics (§68-style) |
| OpenAI-compatible provider | Point `@ai-sdk/openai` (or Ollama adapter) at the configured Ollama `/v1` endpoint and model |
| Structured output helpers | Useful for UNDERSTAND / VERIFY JSON decisions |

**How it fits the Q&A sequence (nothing replaced):**

```text
LangGraph node (e.g. DRAFT_ANSWER)
  → Node calls ai.streamText({ model: ollamaQwen, messages: [...] })
  → tokens → Node forwards SSE deltas to UI
  → LangGraph still owns tools, clarify, verify loops, caps
```

Every call passes through the context budgeter before `generateText` or `streamText`. The system has
no embedding or reranker model.

---

## 3. Architecture

```text
React UI
   │ HTTPS + SSE
   ▼
Fastify  ── Mongoose CRUD · RBAC · enqueue jobs · stream chat
   │
   ├── MongoDB (domain models + document FTS + jobs + conversation summaries)
   ├── GridFS (accepted source/doc bytes; no images)
   ├── encrypted project workspaces
   │     └── current CodeGraph SQLite index + materialized source tree
   ├── Workers (poll jobs → materialize → index/sync → validate/publish)
   └── Ollama (qwen3.8 evaluation artifact behind a bounded inference queue)
```

HTTP never indexes or rebuilds a graph inline. Materialized source and graph files must live on an
encrypted server volume with per-tenant/project filesystem isolation and retention cleanup.

---

## 4. FLOW A — Ingest (heart #1)

**Purpose:** Turn an upload into a tenant-isolated current code graph plus searchable documents,
without storing junk (`node_modules`, images, etc.).

### 4.1 What we accept

| Kind | Formats | Notes |
|------|---------|--------|
| Code | `.js` `.ts` `.mjs` `.cjs` and supported CodeGraph languages | Files over 1 MiB are accepted but excluded from graph indexing |
| Config | allowlisted `.json` and text configs | Available through bounded file reads; not assumed to be graph nodes |
| Docs | `.md`, `.mdx`, `.txt` | Mongo FTS + bounded on-demand reads; not embedded |
| Images | **Skip entirely** | Listed in exclusions; not stored for RAG |
| Archives | `.zip` | Path-filter entries before GridFS write |

### 4.2 `node_modules` during upload

```text
ZIP / multipart / folder list
        │
        ▼
For every path:
  if matches ignore (node_modules/, .git/, dist/, build/, coverage/, …)
       → DO NOT write to GridFS
       → record in job.excludedPaths
        │
If format has no inspectable paths → 400:
  "Remove node_modules (and similar) and re-upload"
```

Prefer also filtering on the client before upload; **server must still enforce**.

### 4.3 End-to-end ingest pipeline

```text
┌─────────────────────────────────────────────────────────────────┐
│ 1. UPLOAD (API)                                                 │
│  Auth + project ACL                                             │
│  Validate zip integrity / zip-slip / allowlist                  │
│  Stream entries: skip ignore + images BEFORE GridFS             │
│  Mark supported code >1 MiB excluded_from_graph                 │
│  Mongoose: create sourceVersion, sourceFile rows, job=pending   │
│  Response 202 { sourceVersionId, jobId }                        │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. WORKER CLAIMS JOB (Mongo findOneAndUpdate)                   │
│  jobStatus: pending → running                                   │
│  Events: "Source received", "Exclusions applied (N paths)"      │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. MATERIALIZE + DOCUMENT INDEX                                 │
│  Recreate tenant/project workspace on encrypted volume          │
│  Materialize accepted current source tree                       │
│  Markdown/MDX/text → scoped Mongo text-indexed sections         │
│  SourceFile records retain path, hash, kind, and exclusions     │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. CODEGRAPH INDEX / SYNC                                       │
│  Worker holds per-project writer lock                           │
│  Disable watcher; call CodeGraph Node API explicitly            │
│  Initial source → full index; changed source → in-place sync    │
│  Validate index status, exclusions, source hashes, and probes   │
│  CodeGraph telemetry disabled                                  │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. KNOWLEDGE VERSION                                            │
│  Link knowledgeVersion ↔ sourceVersion                          │
│  Publish metadata for the current graph only                    │
│  Health: ready | partially_available | failed                   │
│  job → completed / completed_with_warnings / failed             │
└─────────────────────────────────────────────────────────────────┘
```

### 4.4 Scale and coverage notes (~2M LOC)

- CodeGraph's upstream benchmarks are not proof for this product, repository shape, or hardware.
- Its documented hard 1 MiB file exclusion conflicts with complete coverage of some large source
  files. Accepted excluded files force `knowledgeHealth: partially_available`.
- `.cjs` mapping and every accepted language/extension must pass an integration fixture before the
  backend reports it as supported.
- CodeGraph `buildContext(..., { maxNodes })` is node-bounded, not token-budget proof. Its output
  must pass through the backend context budgeter.
- CodeGraph's own README reports larger residual context in long sessions. Never retain raw graph
  payloads indefinitely in conversation context.
- Record index duration, SQLite size/WAL behavior, peak RAM, graph coverage, skipped files, query
  latency, and result bytes on representative ~2M-LOC projects before locking this design.

### 4.5 What is stored where

| Store | Content |
|-------|---------|
| GridFS | Kept source/doc bytes only (no `node_modules`, no images) |
| Encrypted project workspace | Materialized current source tree + current `.codegraph` SQLite index |
| Mongoose `SourceFile` | path, hash, kind, graph exclusion reason, gridFsId |
| Mongoose `SourceVersion` | one ingest event + result |
| Mongoose `DocumentSection` | org/project/version scope, path, heading/lines, searchable text, `status` |
| Mongoose `KnowledgeVersion` | source linkage, graph identity/hash, exclusions, health; only current graph queryable |
| Mongoose `Job` / `JobEvent` | stages humans can read |

### 4.6 Ingest stages, failures, and what survives

Pipeline stages (each writes a `JobEvent`; job stores `currentStage` + checkpoint):

```text
S0 validate_upload
S1 store_files          (GridFS + SourceFile rows)
S2 exclude_apply
S3 materialize_docs     (encrypted workspace + Mongo document sections/FTS)
S4 codegraph_update     (full index or worker-controlled in-place sync)
S5 knowledge_publish    (knowledgeVersion + health)
S6 finalize             (job + project lifecycle)
```

**Failure rules**

| Where it fails | Job / project result | What is kept | Default recovery |
|----------------|----------------------|--------------|------------------|
| S0 validate (bad zip, path slip, empty after excludes) | `failed` immediately; often **no** `sourceVersion` committed, or version marked failed | Nothing usable for RAG | Fix upload → new upload (not “retry junk”) |
| S1 store_files (disk/GridFS error mid-write) | `failed` | Partial GridFS objects marked orphaned / rolled back where possible | **Retry S1** from checkpoint, or discard version + re-upload |
| S2 exclusion | Files over CodeGraph's 1 MiB limit are recorded; processing continues | Excluded bytes remain in GridFS | Publish only as `partially_available` |
| S3 document indexing | Continue unaffected documents; job may warn or fail by policy | Good document sections remain staged | Retry failed documents |
| S4 CodeGraph update | Q&A remains disabled; job retries bounded temporary failures | Current workspace/index may be partially changed | Rebuild from last successfully accepted source tree, validate, then resume |
| S4 recovery exhausted | Knowledge `failed`; graph remains unavailable | Source and failed-job diagnostics remain | Explicit retry/re-ingest; fail queued messages with retryable error |
| S5 publish | `failed`; Q&A remains unavailable | Validated index may exist but is not ready | Retry publish only |
| Worker crash mid-stage | Job stuck `running` → sweeper marks `failed` or requeues `pending` after lease timeout | Checkpointed stage + per-file progress | Automatic reclaim + **resume from last completed stage** |

**Hard rules**

1. A failed job **never disappears** — UI can open job events + error codes later.  
2. Do **not** mark project `knowledge_ready` unless S5 succeeded for the intended version.  
3. Distinguish errors: `temporary` (Ollama/network) → auto-retry with backoff; `permanent` (corrupt file) → no endless retry; `user_action_required` (bad archive) → clear message.  
4. Idempotent retries: the same key/version/stage must not create duplicate document sections or
   parallel graph writers.
5. CodeGraph filesystem watching is disabled; only the source-version worker may update the graph.
6. Q&A must not read the graph during update, validation, or recovery.

```text
Example: in-place CodeGraph sync fails
  → Q&A remains disabled; accepted questions stay queued
  → worker rematerializes the last successfully accepted source tree
  → worker rebuilds and validates the current graph
  → success: publish ready/partial and resume unexpired queued questions
  → retries exhausted: graph failed; queued messages fail with retryable error
```

### 4.7 Re-ingest (same source version vs new version)

Two different operations:

| Action | API intent | When to use | Behavior |
|--------|------------|-------------|----------|
| **Retry failed** | `POST .../jobs/:jobId/retry` | Last job failed / partial; bytes already stored | Resume recoverable document stages or rebuild the graph; no new `sourceVersion` |
| **Re-ingest version** | `POST .../sources/:sourceVersionId/reingest` | Index rules changed; rebuild from GridFS | New job on the same source bytes; regenerate document sections and current graph |
| **Replace source (re-upload)** | new upload | User sends a new ZIP/files | **New** `sourceVersion`; diff by path+sha256 vs previous ready version (§4.8) |

Retry UI must show: stage failed, error code, “Retry failed steps” vs “Upload new source”.

Duplicate clicks: idempotency key on retry/reingest — second call returns existing active job, does not start a second writer on the same project.

### 4.8 Source updates — re-upload and Git pull (every 30 minutes)

A project is not a one-shot upload. Updates create a **new `sourceVersion`**, then an incremental knowledge update.

#### A) Manual re-upload

```text
User uploads new ZIP / files
  → same path filters (skip node_modules, images, …)
  → sourceVersion N+1 (origin: upload, actor, timestamp)
  → job: ingest
  → Diff vs last successful version N:
        added    = paths only in N+1
        removed  = paths only in N
        changed  = same path, different sha256
        unchanged = same path+hash → no document re-index work for that path
  → accept and persist sourceVersion N+1
  → disable Q&A; new questions persist as queued
  → update materialized tree + document FTS + current CodeGraph index in place
  → validate graph and exclusions, then publish current knowledge metadata
  → resume unexpired queued questions against the new current graph
```

#### B) GitHub / GitLab sync every 30 minutes

```text
Project has repo connection + selected branch + credentials (encrypted)
  → Scheduler (Mongo job, every 30 min per connected project):
        enqueue job type: repo_sync
  → Worker:
        1. git fetch / pull (or API archive) for selected branch
        2. If remote unreachable / auth failed:
             connectionStatus: failed | auth_required | …
             job failed before graph mutation; current graph remains ready; notify
        3. If commit SHA == last synced SHA:
             job completed “no changes”; exit
        4. Else:
             materialize tree (skip node_modules etc.)
             new sourceVersion (origin: github|gitlab, commitSha, branch)
             same worker-controlled materialize/document-FTS/CodeGraph path as re-upload
        5. Record nextDueAt = now + 30 minutes
```

| Setting | MVP default |
|---------|-------------|
| Sync interval | **30 minutes** (configurable per project later) |
| Overlap | If previous `repo_sync` still `running`, **skip** tick (no parallel syncs on same project) |
| Manual sync | `POST .../repositories/sync` enqueues same job immediately (idempotent) |
| Branch change | User selects new branch → full tree as new sourceVersion (diff still applies vs previous) |

**Concurrency with chat:** one graph writer runs per project. Once graph mutation starts, Q&A for
that project is disabled. A message submitted during this period is persisted as `queued`; the API
returns `202` with message and job identifiers. The UI polls or reconnects when processing starts.
Queued messages have a configurable evaluation-derived expiry.

**Conversation version behavior:** only the current graph is retained. After publish, an older
conversation moves to the new graph, preserves its prior evidence snapshots, and shows a
knowledge-version-change warning. Historical graph traversal is not available.

**Failure during update:** because sync changes the only graph in place, the previous graph cannot
be assumed valid after failure. Q&A remains disabled while the worker rebuilds from the last
successfully accepted source tree. On successful validation, queued questions resume. If bounded
recovery or queue expiry is exhausted, messages fail with a structured retryable
`KNOWLEDGE_UNAVAILABLE` error.

```text
Timeline example
  t0  current graph ready for sourceVersion 3
  t1  sourceVersion 4 accepted; Q&A disabled; new questions queued
  t2  in-place sync fails; Q&A remains disabled
  t3  worker rebuilds from last successfully accepted source tree and validates
  t4  graph becomes ready/partial; unexpired queued questions resume
```

---

## 5. FLOW B — Q&A (heart #2)

**Purpose:** User sends a question → system returns a grounded Markdown answer (or a clarification set, or abstain), with evidence the UI can open.

**Actors (who does what)**

| Actor | Role |
|-------|------|
| **UI (React)** | Sends message; shows SSE stages; if clarification set arrives, asks one question at a time, then POSTs all answers once |
| **Fastify / Node.js API** | Auth, load/save Mongo data, open SSE, start/resume LangGraph, stream events to UI |
| **Mongoose / MongoDB** | Conversations, queued messages, summaries, document FTS, knowledge metadata, evidence |
| **CodeGraph library** | Queries the current project graph for symbols, routes, relationships, source, and flows |
| **LangGraph (in Node)** | State machine: decide next step, call scoped tools, budget context, call LLM |
| **Ollama** | Runs the human-controlled Qwen3.8 artifact behind a bounded inference queue |

There are no embedding or reranker model calls.

---

### 5.1 Happy path — sequence after the API receives a message

Example request:

```http
POST /api/v1/conversations/:conversationId/messages
Accept: text/event-stream
{ "content": "How does checkout work?" }
```

#### Step 1 — Node API receives the HTTP request

**Who:** Fastify handler  

1. Authenticate JWT; resolve `organizationId`, `userId`.  
2. Load conversation via Mongoose; check project ACL + “ask questions” permission.  
3. If graph update/recovery is active, persist the message as `queued` and return `202` with message
   and job identifiers. Do not open a long-lived waiting SSE stream.
4. If the graph is failed/unavailable, persist a structured retryable failure.
5. If knowledge is ready/partial, create the user message as `accepted`, open SSE, and emit
   `status: accepted`. Partial health is included in the run and answer.
6. Build a **run context bag** in memory (not yet LLM):

```text
runContext = {
  orgId, projectId, userId, conversationId, userMessageId,
  question: "How does checkout work?",
  knowledgeVersionId: project.currentReadyKnowledgeVersionId,
  contextBudget: validatedModelBudget,
  runBudgets: configuredEvaluationBudgets,
  correlationId
}
```

#### Step 2 — Node loads conversation context from MongoDB

**Who:** Node service + Mongoose  

Loads and attaches to `runContext`:

| Data | From Mongo | Why |
|------|------------|-----|
| Recent messages | newest turns that fit the measured budget | Follow-ups (“the second step”) |
| Context summary | required persisted summary for older history | Older context without silent loss |
| Pinned facts | clarifications / user corrections if any | Stable entities |
| Knowledge health | `KnowledgeVersion` + project health | Stale/partial warnings |
| Previous evidence snapshots | prior answer source refs/excerpts within budget | Trace old answers after graph changes |
| (Not loaded yet) | CodeGraph output / document text / whole repo | Tools fetch bounded evidence later |

Node does not dump the project into the LLM. It measures the exact assembled prompt before every
call and applies §1.2.

#### Step 3 — Node starts LangGraph with that bag

**Who:** Node calls `chatGraph.invoke` / `stream` with initial state:

```text
LangGraph state = {
  ...runContext,
  rewrittenQuestion: null,
  clarificationSet: null,
  clarificationAnswers: null,
  toolResults: [],      // evidence gathered
  draftAnswer: null,
  verifyResult: null,
  reviseCount: 0,
  cumulativeInputTokens: 0,
  cumulativeOutputTokens: 0,
  cumulativeToolResultBytes: 0,
  startedAt
}
```

From here, **LangGraph decides the next node**; Node executes each node’s side effects (Mongo, Ollama, SSE).

---

### 5.2 LangGraph nodes — who calls whom

```text
[Node API] ──state──► LangGraph
                         │
                         ▼
                    UNDERSTAND
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
      CLARIFY_SET    AGENT_TOOLS   ABSTAIN_EARLY
      (wait UI)      (loop)        (rare)
                         │
                         ▼
                   DRAFT_ANSWER
                         │
                         ▼
                   VERIFY_ANSWER
                      pass / fail→revise
                         │
                         ▼
                   PERSIST + DONE
```

#### Node A — UNDERSTAND

**Who:** LangGraph node → Node budgets the exact prompt → calls the configured **Qwen3.8**
artifact through `ai.generateText` with thinking disabled → validates the structured decision.

**Input to LLM (built by Node):**

- System: “Rewrite the user question using conversation context; decide if clarification is needed; do not answer the project question yet.”  
- Recent messages + summary + raw user question  

**LLM returns structured decision (example):**

```json
{
  "rewrittenQuestion": "Explain the checkout flow in this Node app",
  "needsClarification": false,
  "clarificationQuestions": [],
  "route": "retrieve"
}
```

**Node then:**

- Writes `rewrittenQuestion` into graph state  
- SSE: `status: understanding_question`  
- Records measured context consumption and compaction metadata

**Branch:**

| Decision | Next |
|----------|------|
| `needsClarification: true` | Node B — CLARIFY_SET |
| `route: retrieve` | Node C — AGENT_TOOLS |
| Clearly impossible / no knowledge | Early abstain → PERSIST |

#### Node B — CLARIFY_SET (optional)

**Who:** LangGraph + Node + UI (not Ollama again unless understand already produced the set)

1. **LLM (during UNDERSTAND)** already produced **all** clarification questions in one JSON array (single_select / multi_select / free_text).  
2. **Node** saves clarification set on the message / `Clarification` collection; SSE `clarification` event with the **full list**.  
3. Graph **interrupts / waits** (checkpoint in Mongo).  
4. **UI** shows Q1, then Q2, … locally.  
5. **UI** one POST: `{ clarificationId, answers: { q1: "...", q2: "..." } }`.  
6. **Node** loads checkpoint, merges answers into state, resumes LangGraph at UNDERSTAND (or AGENT_TOOLS) with answers bound.  

No per-question server round-trip after the set is issued. Max **1** extra clarification set if answers still insufficient.

#### Node C — AGENT_TOOLS (gather evidence)

**Who:** LangGraph asks the configured Qwen3.8 artifact which scoped tool to call. Node executes the
CodeGraph or Mongo/document tool, measures returned bytes/tokens, applies the context budget, and
appends accepted evidence to `toolResults`.

There is no fixed tool-round cap. Before each iteration, Node enforces configurable total-call,
cumulative token, tool-result byte, and wall-time budgets. Exhausting any budget stops the loop with
a clarification, grounded partial answer, abstention, or structured error.

When the model requests structural code exploration:

```text
1. Confirm current graph health and acquire a project-scoped read lease
2. Open the CodeGraph instance for the authorized materialized project path
3. Call buildContext/explore with a bounded node/result setting
4. Reject stale, cross-project, unlocated, or oversized results
5. Convert accepted source locations/snippets/edge provenance into evidence records
6. Pass those records through the exact token budgeter
7. Append only the highest-ranked evidence that fits
8. Close/release the graph read resources
9. SSE: searching_code → reviewing_sources
```

Document/configuration tools:

| Tool | Node does |
|------|-----------|
| `search_documents` | Tenant/project/current-version Mongo FTS over Markdown/MDX/text sections |
| `list_documents` | List authorized active document paths with bounded pagination |
| `read_document_slice` | Read a bounded heading/line range and return source metadata |
| `read_file_slice` | Read bounded code/config lines for a known authorized path |
| `explore_code` | Call the CodeGraph Node library for structural context and source locations |
| `abstain` | Skip draft; finalize insufficient-info message |

#### Node D — DRAFT_ANSWER

**Who:** Node builds the exact prompt, applies §1.2, and calls `ai.streamText` with the configured
Qwen3.8 artifact and bounded thinking. Node maps text deltas to SSE.

**Prompt contents (assembled by Node):**

- Rewritten question  
- Short conversation context  
- **Only** `toolResults` evidence blocks (with ids)  
- Rules: answer from evidence only; cite evidence ids; if missing → say so; Markdown; **no** private chain-of-thought in the user-visible answer  

**Node:**

- SSE `status: generating_answer`  
- SSE `delta` for each token from `streamText`  
- Record measured preflight context and provider usage when present
- Stores full draft on graph state  

#### Node E — VERIFY_ANSWER

**Who:** Node first runs deterministic checks. Only unresolved checks call the configured Qwen3.8
artifact through budgeted `ai.generateText` with bounded thinking.

**Checks (programmatic + LLM structured):**

1. Every non-trivial claim maps to an evidence id in `toolResults`.  
2. Cited path/lines exist; optional Node re-`read_file_slice` to confirm quote.  
3. Same `knowledgeVersionId` / project scope.  
4. If evidence empty → must abstain, not invent.

| Result | Next |
|--------|------|
| PASS | Node F |
| FAIL while run budgets remain | Retrieve/revise again |
| FAIL and budget exhausted | Persist abstain / partial grounded answer with warning |

SSE: `status: verifying_answer` (no internal reasoning text).

#### Node F — PERSIST + DONE

**Who:** Node + Mongoose  

1. Insert assistant `Message`: markdown, `evidence[]`, support level, tokens, duration, `knowledgeVersionId`, `messageStatus: 'completed'`.  
2. Persist context-limit metrics, compaction actions, and the model identifier supplied by the
   human-controlled configuration.
3. Persist/update the conversation summary before older turns would exceed the validated budget.
4. Update title if needed; SSE `evidence`, `usage`, `done { messageId }`; close stream.

---

### 5.3 End-to-end swimlane — where npm `ai` is used

**Rule of thumb**

| Call type | Library | Why |
|-----------|---------|-----|
| Qwen3.8 UNDERSTAND / tool choice / draft / conditional verify | `ai` SDK → configured Ollama OpenAI endpoint | Structured output, streaming, abort, reliable provider usage |
| Structural code retrieval | `@colbymchenry/codegraph` Node API | Current graph relationships and located source |
| Document discovery/read | Mongoose/Mongo FTS + GridFS/materialized slices | On-demand bounded evidence without vectors |

Every Qwen call goes through the exact tokenizer/context budgeter before the `ai` SDK. CodeGraph and
document outputs also pass through the result-byte and prompt-token budgets.

```text
UI          Node/Fastify          MongoDB       LangGraph      CodeGraph       ai/Ollama
│ POST msg  │                     │             │              │               │
│──────────►│ auth + ACL          │             │              │               │
│           │ graph updating?     │             │              │               │
│           ├─ yes: save queued ─►│             │              │               │
│◄─ 202 ids─│                     │             │              │               │
│           ├─ no: save accepted ►│             │              │               │
│           │ load summary/facts ◄│             │              │               │
│           │ graph.stream(state) ─────────────►│              │               │
│           │ budget UNDERSTAND prompt          │              │               │
│           │─────────────────────────────────────────────────────────────────►│
│           │◄──────────────────── structured route / clarification ───────────│
│           │                     │             │ choose tool  │               │
│           │ acquire graph lease │             │              │               │
│           │────────────────────────────────────────────────►│               │
│           │◄──────── located code + relationships ──────────│               │
│           │ or scoped document FTS/read ◄───►│              │               │
│           │ budget tool bytes + draft prompt │              │               │
│           │─────────────────────────────────────────────────────────────────►│
│◄─ deltas ─│◄──────────────────── streamed grounded answer ───────────────────│
│           │ deterministic verify; conditional LLM verify    │               │
│           │ save answer/evidence/context metrics ──────────►│               │
│◄─ done ───│                     │             │              │               │
```

**Concrete `ai` usage in code terms (illustrative):**

```ts
// shared: OpenAI-compatible client pointed at Ollama
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText, Output } from 'ai';

const ollama = createOpenAI({
  baseURL: 'http://127.0.0.1:11434/v1',
  apiKey: 'ollama', // required by client; ignored by Ollama
});
const chat = ollama(configuredModelId);

// Every messages array is produced by the exact tokenizer/context budgeter first.
const { output, usage } = await generateText({
  model: chat,
  messages: budgetedMessages,
  // structured decision JSON
});

// DRAFT_ANSWER → UI SSE
const result = streamText({ model: chat, messages: budgetedMessages });
for await (const partial of result.textStream) {
  reply.sse({ event: 'delta', data: { text: partial } });
}
```

The application never pulls or upgrades the model automatically. Human operators control the
installed model and version. Each run records the configured model identifier and the Ollama
artifact metadata/digest when the runtime exposes it.

---

### 5.4 Clarification contract (summary)

| Who | Does |
|-----|------|
| **LLM (in UNDERSTAND)** | Emits **all** questions in one set |
| **UI** | Displays **one at a time** |
| **UI → API** | One payload with **all** answers |
| **Node** | Resumes LangGraph once with the full answer map |

---

### 5.5 Tools (reference)

All tools run in Node and enforce `organizationId + projectId + currentKnowledgeVersionId +
status:'A'` before resolving a workspace path or Mongo query.

| Tool | Runs on | Uses Ollama? |
|------|---------|--------------|
| `explore_code` | CodeGraph Node API | No |
| `search_documents` | Mongo text index | No |
| `list_documents` | Mongo source metadata | No |
| `read_document_slice` | GridFS/materialized file | No |
| `read_file_slice` | GridFS/materialized file | No |
| `abstain` | Node | No |

**Not in MVP:** live Mongo query execution against the *target* app DB, shell, web, cross-project, images.

---

### 5.6 Run bounds

| Bound | Policy |
|-------|--------|
| Clarification sets | One, plus at most one follow-up set |
| Tool rounds | No fixed count |
| Total model/tool calls | Configurable value selected by evaluation |
| Cumulative tokens | Configurable measured input/output budget |
| Tool-result bytes | Configurable cumulative budget |
| Wall time | Configurable deadline |
| Queue wait | Configurable expiry; then retryable failure |
| Safety abort | Structured terminal event/error + `correlationId` |

---

### 5.7 Follow-ups

User: “What about the second step?”  

1. Node loads prior assistant message + its `evidence[]` from Mongo into context.  
2. UNDERSTAND rewrites to a full question using that context.  
3. If knowledge changed, the conversation moves to the current graph and the UI receives a
   version-change warning; the old evidence snapshot remains attached to the old answer.
4. Same tool → draft → verify path. User does not need to repeat the original question.

---

### 5.8 Failures during Q&A

| Failure | Behavior |
|---------|----------|
| Qwen/Ollama timeout or OOM | Temporary error; message failed; retryable SSE error + correlation id |
| Tokenizer missing/mismatched | Fail closed before LLM call with `CONTEXT_ACCOUNTING_UNAVAILABLE` |
| Prompt cannot fit after ordered compaction | Ask user to narrow the question or abstain |
| CodeGraph update/recovery active | Persist queued message; return `202`; process after validated publish |
| CodeGraph query/index unavailable | Abstain or retryable `KNOWLEDGE_UNAVAILABLE`; no model-only code answer |
| Document search has no support | Continue with code evidence if sufficient; otherwise abstain |
| Any cumulative run budget exhausted | Grounded partial answer, clarification, abstention, or structured failure |
| Client disconnect mid-SSE | Graph/run continues; message ends `completed` or `failed`; UI reloads message by id |
| Clarification abandoned | Message stays `awaiting_clarification`; resumable |

---

### 5.9 Guarantees

1. Node always scopes Mongo/tool access to this org/project/knowledge version.  
2. Prefer abstain over invention.  
3. Final project claims include inspectable `evidence[]` or an explicit insufficient-info message.  
4. Conversation context is private; it does not write into project knowledge.  
5. Never send a full source tree or unbudgeted CodeGraph/document output to the LLM.
6. Files over 1 MiB are visible exclusions and force partial knowledge.
7. Every LLM call passes exact preflight token accounting or fails closed.
8. UI never sees private chain-of-thought—only stages, clarification, answer, evidence, and metrics.

---

## 6. Mongoose usage

See [ADR 0003](../docs/adr/0003-mongoose-and-gridfs.md).

Use **Mongoose** for:

- All domain CRUD (organizations, users, roles, memberships, projects, source versions/files, jobs, conversations, messages, clarifications, knowledge versions, document sections)
- Platform ops models: `AuditEvent`, `Notification`, `UsageEvent` / `UsageRollup`, `IdempotencyRecord`
- Schema validation and tenant-scoped text/index keys for documents, conversations, jobs, and metadata
- Soft-delete helpers (`status: 'D'`) and query defaults (`status: 'A'`)
- Job claim updates and conversation persistence

GridFS stores accepted bytes. Mongo stores document sections for scoped FTS. CodeGraph owns the
current structural SQLite index in the encrypted project workspace; Mongo stores its health and
source-version metadata.

---

## 7. Jobs without Redis

See [ADR 0004](../docs/adr/0004-mongo-jobs-no-redis.md).

```text
pending → running → completed | completed_with_warnings | failed | retrying | cancelled
```

Worker: atomic claim → run ingest stages → write `JobEvent` lines → complete or fail with stage checkpoint.  
Serialize knowledge writers per project (one active knowledge/sync job).  
**Lease sweeper:** `running` jobs with expired `heartbeatAt` → requeue or fail (crash recovery).  
**Scheduled:** `repo_sync` due every **30 minutes** per connected repo (Mongo `scheduledAt` / worker tick) — see §4.8.  
Retry: only temporary failures auto-backoff; permanent / user_action_required wait for explicit retry or new upload.

---

## 8. Org / user / RBAC admin APIs

**Purpose:** Multi-tenant identity and authorization so every ingest/Q&A call is scoped and permission-checked on the backend (requirements §§3–6, 89–90, 135–136).

### 8.1 Domain model (Mongoose)

| Model | Key fields | Notes |
|-------|------------|-------|
| `Organization` | name, slug, config, `status` | Tenant root |
| `User` | orgId, email, passwordHash, `userStatus` (`active`\|`invited`\|`disabled`), `status` | Soft-delete via `status:'D'` |
| `Role` | orgId, name, permissions[] | Built-in + custom |
| `Membership` | orgId, userId, roleIds[] | User belongs to one org in MVP |
| `ProjectMember` | orgId, projectId, userId, permissions[] \| roleId | Project ACL overlay |

**Row visibility:** all list/detail queries default `status:'A'`. Domain lifecycle uses separate fields (`userStatus`, `lifecycleStatus`, etc.).

### 8.2 Permission catalog (MVP)

Enforce on every protected route (never UI-only):

```text
org.view | org.manage
users.manage | roles.manage
projects.create | projects.view | projects.update | projects.delete
sources.upload | repos.connect | knowledge.trigger | knowledge.view
chat.ask | conversations.view | conversations.archive | conversations.search
search.run | knowledge.browse | sources.preview
audit.view | usage.view | settings.manage
notifications.view
```

Built-in roles: `org_admin` (all), `project_admin`, `member` (view + chat + search), `viewer` (view + search, no ask if policy says so).

### 8.3 Auth

See [ADR 0007](../docs/adr/0007-argon2id-jwt.md) (passwords + access JWT),
[ADR 0008](../docs/adr/0008-httponly-refresh-cookie.md) (httpOnly refresh cookie + CSRF),
and [ADR 0012](../docs/adr/0012-refresh-token-rotation.md) (rotation + strict reuse detection).

| Concern | MVP |
|---------|-----|
| Password | argon2id hash (OWASP minimum costs as named constants); never log plaintext |
| Session | JWT access token (15 min TTL, in memory) + refresh token (httpOnly cookie, 1 day absolute TTL; D14) |
| Refresh | Rotate on every use; reuse revokes the whole session family (no grace window) |
| Login / logout / refresh / me | `/api/v1/auth/*` |
| Password reset | Admin-mediated only (D15 / ADR 0013): administrator sets `newPassword` on `POST /users/:id/reset-password`; secret never returned; user receives it out of band. Signed-in self-service `POST /auth/password/change` stays. No public forgot/reset-token flow |
| Bootstrap | Startup seed sets default admin password from a named constant (ADR 0011) — no open signup |

### 8.4 Admin API surface (`/api/v1`)

```text
POST   /organizations (platform bootstrap only) | GET/PATCH /organizations/:orgId
POST   /users | GET /users | GET/PATCH /users/:id | POST /users/:id/deactivate | POST /users/:id/activate
POST   /users/:id/reset-password
GET/POST /roles | PATCH /roles/:id
POST/DELETE /projects/:id/members
GET/PATCH  /projects/:id/settings
```

Every handler: JWT → resolve org → RBAC + project ACL → audit sensitive actions (§9).

---

## 9. Audit logging (admin / security ops)

**Purpose:** Immutable-enough trail for security-sensitive and admin actions (requirements §§86–87, 134, 150).

### 9.1 Model `AuditEvent`

```text
organizationId, actorUserId?, action, resourceType, resourceId?,
result: success|denied|failed, correlationId, ip?, userAgent?,
context: { …non-secret metadata }, createdAt, status:'A'
```

- **Append-only for MVP:** no update/delete APIs for clients. Soft-delete/`status:'D'` only via retention job (§12), not user delete.
- **Never store:** passwords, repo/DB credentials, raw source bodies, full chat content, query result rows. Store ids, counts, paths (when policy allows), error codes.

### 9.2 What must be audited

| Category | Examples |
|----------|----------|
| Identity | user create/activate/deactivate, password reset, role/permission changes |
| Projects | create, soft-delete, settings change |
| Source | upload accepted, repo connect, credential replace/revoke, sync trigger |
| Knowledge | ingest job completed/failed, reingest, publish |
| Chat (policy) | conversation archive/delete; optional “source preview viewed” |
| Admin | retention/config changes |

### 9.3 API

```text
GET /api/v1/audit-events?from&to&actor&action&resourceType&cursor
```

Requires `audit.view`. Keyset pagination. Filter always includes caller’s `organizationId`.

---

## 10. Conversation edit / archive / search

**Purpose:** Persistent, recoverable chat UX beyond the happy-path Q&A flow (requirements §§41, 46–49).

### 10.1 Edit + replace downstream (this slice)

**Chosen behavior:** editing a prior **user** message **replaces the rest of that thread**.
One conversation, no branch switcher.

```text
Original thread:  U1 → A1 → U2 → A2
User edits U1
  → U1 content is updated in place
  → A1, U2, A2 are removed from the active thread (soft-delete)
  → new answer run from edited U1 (same FLOW B)
  → UI shows that later messages were discarded
```

| Rule | Behavior |
|------|----------|
| Who can edit | Author of the user message + `chat.ask` |
| What is stored | Edited user message is the current content; downstream messages `status:'D'` |
| Resubmit | Same FLOW B from edited content |
| Visibility | Single thread after refresh; no branch list |

### 10.2 Archive / restore / delete

| Action | API | Persistence |
|--------|-----|-------------|
| Archive | `POST .../conversations/:id/archive` | `lifecycleStatus: archived` (history intact) |
| Restore | `POST .../conversations/:id/restore` | back to `active` |
| Delete | `DELETE .../conversations/:id` | soft-delete `status:'D'` — not hard purge |

List endpoints default: `status:'A'` and `lifecycleStatus != archived` unless `?archived=1`.

### 10.3 Conversation search

```text
GET /api/v1/projects/:projectId/conversations/search?q=&cursor=
```

- Scope: caller’s accessible project + own conversations (or all project convos if `conversations.view` is org-wide — **MVP: own conversations + shared-if-any; org_admin can search all in project**).
- Match: title, user message text, assistant message text (Mongo text index).
- Return: conversation id, title, snippet, updatedAt — **no** cross-tenant leakage.

### 10.4 Titles

Auto-title after first successful assistant answer (async or inline short prompt); user can `PATCH` title anytime.

---

## 11. Search + Knowledge browse APIs

**Purpose:** UI can explore project knowledge and jump into chat without going only through the agent tools (requirements §§130–133).

### 11.1 Project Knowledge browse

```text
GET /api/v1/projects/:projectId/knowledge
GET /api/v1/projects/:projectId/knowledge/summary
GET /api/v1/projects/:projectId/knowledge/workflows
GET /api/v1/projects/:projectId/knowledge/apis
GET /api/v1/projects/:projectId/knowledge/symbols?q=
GET /api/v1/projects/:projectId/knowledge/health
```

All endpoints are scoped to the current graph and active document sections for the authorized
organization/project. Historical graph IDs are not queryable. CodeGraph supplies supported
symbols, routes, relationships, and located source; document summaries are produced only from
bounded on-demand reads. During graph update/recovery, code-graph browse returns structured
knowledge-updating/unavailable state. Requires `knowledge.browse` / `knowledge.view`.

### 11.2 Project Search API

```text
GET /api/v1/projects/:projectId/search?q=&types=code,doc,symbol,workflow&cursor=
```

| Step | Behavior |
|------|----------|
| Auth | JWT + `search.run` + project ACL |
| Retrieve | Code/symbol/workflow via bounded CodeGraph query; docs via scoped Mongo FTS |
| Response | Located, typed results with current knowledge version and source references |

**Ask about this:** attached search-result IDs are resolved again under tenant/project/current-version
scope, converted to evidence, and passed through the prompt budget before UNDERSTAND.

### 11.3 Source preview API

```text
GET /api/v1/projects/:projectId/files?path=
GET /api/v1/projects/:projectId/files/slice?path=&startLine=&endLine=
```

- Cap response bytes/tokens through validated configuration rather than an untested fixed line count.
  Requires `sources.preview`.
- Bytes come from GridFS/materialized source. Graph-excluded files may be previewed when authorized,
  but they must be labeled excluded and cannot be represented as graph-derived knowledge.
- Optional audit: `source.preview` event when policy enabled (§9).

---

## 12. Notifications / usage / retention

### 12.1 Notifications (in-app MVP)

**Channel:** Mongo `Notification` collection + list/SSE poll. **No email/SMS in MVP.**

| Event → notification | When |
|----------------------|------|
| `knowledge.completed` / `knowledge.failed` | Ingest/publish finishes |
| `repo.sync.completed` / `repo.sync.failed` | Git sync job ends |
| `processing.attention` | `user_action_required` / partial below threshold |
| (DB approval) | Out of MVP with live DB path |

```text
GET  /api/v1/notifications?unread=1
POST /api/v1/notifications/:id/read
POST /api/v1/notifications/read-all
GET  /api/v1/notifications/stream   (optional SSE)
```

Fields: orgId, userId (recipient), type, title, body, resourceRef, readAt?, createdAt, `status:'A'`. Fan-out to project members with relevant permissions.

### 12.2 Usage tracking

Record **actual** backend activity only (no estimates):

| Level | Counters / facts |
|-------|------------------|
| Organization | questions, ingest jobs, source bytes accepted, token in/out (when SDK reports), search calls |
| Project | same, scoped |
| User | questions, jobs triggered, tokens, searches |

Model: `UsageEvent` (append) and/or daily `UsageRollup` documents. Expose:

```text
GET /api/v1/usage/organization
GET /api/v1/usage/projects/:projectId
GET /api/v1/usage/me
```

Requires `usage.view` (self always sees `/me`).

### 12.3 Retention

Configurable **per organization** (defaults below). Enforced by scheduled Mongo job (same worker poller).

| Data | MVP default | Action after expiry |
|------|-------------|---------------------|
| Source bytes (old versions) | keep last **3** ready versions; older GridFS soft-orphan then purge job | Policy-driven |
| Knowledge versions | tied to retained source versions | soft-delete then purge |
| Conversations | **365 days** inactive archived → soft-delete | `status:'D'` |
| Job / processing history | **180 days** | soft-delete |
| Audit events | **730 days** | soft-delete only via retention (still no client delete) |
| Notifications | **90 days** or 30 days after read | soft-delete |
| Usage rollups | **730 days** | delete rollup rows (aggregates only) |

Hard purge of GridFS objects is a separate admin path; document in ADR when enabled. Deleting a project → soft-delete project + schedule cascade soft-delete of sources/knowledge/conversations per org policy; audit rows remain until retention.

---

## 13. Rate limit / idempotency

### 13.1 Rate limiting (not in the API process)

The API is expected to run under **PM2 cluster mode on multiple hosts**. In-process rate-limit
counters cannot be correct across workers and machines. **The Node API does not enforce
per-route rate limits** (`@fastify/rate-limit` is not used). Requirements §91, if needed in
an environment, are satisfied at the **load balancer / edge**, not inside Fastify.

Catalog code `RATE_LIMITED` may still appear when an upstream returns `429`; the app does not
emit it from an in-app limiter.

### 13.2 Idempotency

Clients send `Idempotency-Key` header on mutating/async starts that opt in
(`config.requireIdempotencyKey: true`). Missing header → `400 IDEMPOTENCY_KEY_REQUIRED`.

| Operation | Behavior |
|-----------|----------|
| Upload / create sourceVersion | Same key + user + route → return existing `202` body; no second writer |
| Job retry / reingest / repo sync | Same key → existing active job |
| Chat message create | Same key → existing message + reconnect SSE / load status (no duplicate user rows) |
| Admin creates (user, project) | Same key → existing resource |

Store `IdempotencyRecord { key, orgId, userId, route, requestHash, recordState, responseStatus, responseBody, resourceId, expiresAt }` in **MongoDB** (TTL ~24h) so keys are shared across PM2 workers and API hosts. Concurrent duplicates: first wins; second waits or gets the stored response. Same key with a different body → `409 IDEMPOTENCY_KEY_REUSE`.

---

## 14. Out of MVP

### Live customer-DB / SQL Q&A path (deferred; matches requirements §1)

Requirements §§71–82 / 121–126 describe answering questions by **querying the customer’s application database** (e.g. “How many customers cancelled last month?”): detect need → generate query → validate → authorize → optional approval → **execute live** against a configured project data source → interpret rows into Markdown.

That is **not** the platform MongoDB used for tenants, documents, jobs, and conversation state. Those sections are future requirements, not this slice. MVP Q&A answers only from **ingested source + documentation** (and tools in §5). No project DB credentials, no generated SQL/MQL execution, no query approval workflow.

### Also out of MVP

- Image upload / vision descriptions
- Document or code embeddings, vector search, or a reranker
- Redis, BullMQ, LocalStack S3
- Atlas requirement (optional later)
- Email/SMS notification channels
- Cross-project search/chat

---

## 15. Success checks

| Check | Pass when |
|-------|-----------|
| Scale | Ingest designed for ~2M LOC Node+Mongo apps; files over 1 MiB excluded from the graph and force `partially_available` |
| Upload | `node_modules` + images skipped before GridFS when paths visible |
| Retrieval | CodeGraph for code; Mongo FTS + bounded reads for docs; **no** embeddings, vector search, or reranker |
| Ollama | Bounded inference queue for the configured chat artifact only |
| Ingest | Upload → job events → document sections + current graph + knowledge ready/partial/failed |
| Stage failure | Failed job retained; retry resumes from checkpoint or rebuilds the graph from last accepted source |
| Re-upload / git | New sourceVersion; hash diff; unchanged paths skip document re-index; sync every 30 min |
| Sync failure | Q&A stays disabled; worker rebuilds from last successfully accepted source tree; queued messages resume or fail retryable |
| Clarify | Backend sends full question set; UI one-at-a-time; one answers payload |
| Tools | Agent only uses listed project-scoped tools |
| Verify | Citations/paths/scope checked; revise while run budgets remain; else abstain or grounded partial |
| QA | Question → tools → verified Markdown + evidence (or abstain) |
| CRUD | Domain persistence via Mongoose |
| RBAC | Admin APIs enforce org + project permissions; JWT + argon2 |
| Audit | Sensitive admin/source/knowledge actions append AuditEvent; listable with audit.view |
| Conversations | Edit replaces downstream messages on one thread; archive/restore/soft-delete; search by title/messages |
| Search / knowledge | Browse + search APIs; Ask-about-this attaches results into chat |
| Source preview | Authorized slice API with configured byte/token cap |
| Notifications | In-app events for knowledge/sync/attention; read APIs |
| Usage | Actual counters at org/project/user; no fabricated metrics |
| Retention | Scheduled policy soft-deletes per defaults |
| Rate limit | 429 with structured error on abuse budgets |
| Idempotency | Replay of upload/retry/sync/chat key returns same resource |
