# Architecture

This is the map of the system: which processes exist, how they talk, and the two main
workflows (ingest and chat). Implementation detail lives in
[`backend/solution.md`](../backend/solution.md). Product rules live in
[`backend/requirments.md`](../backend/requirments.md) and
[`frontend/requirments.md`](../frontend/requirments.md).

If you already build typical SaaS (React → Node API → MongoDB + a background worker),
you already know most of this. The unusual parts are **how we retrieve code**, **how we
call a language model**, and **how we refuse to invent answers**.

---

## 1. What the product does

Users connect or upload a software project (source + docs). A **background job** turns
that into searchable project knowledge. Users then ask questions in chat. Every answer
must point at **real files and line ranges** from that project. If the system cannot
find enough support, it **asks a clarifying question** or **says it does not know**.
It must not guess.

```text
Upload / connect repo     Background job              Chat
ZIP, files, or Git   →    index code + docs     →     grounded answer
                          (minutes, not in            with evidence the
                           the HTTP request)           UI can open
```

This version of the product (**this slice**) does **not**:

- Query the customer’s live application database
- Accept images as source
- Use embeddings, a vector database, or a reranker

Code questions go through **CodeGraph** (a structural code index). Document questions go
through **MongoDB text search** plus bounded file reads.

Some numbers (exact model, context size, how many LLM calls can run at once) are still
being measured. The process layout below is the intended topology.

---

## 2. Runtime processes

Stack choices for this topology (Fastify, MongoDB replica set, Mongoose/GridFS, Mongo
jobs, logging) are recorded under [`docs/adr/`](./adr/README.md) — especially
[0001](./adr/0001-mongodb-replica-set.md), [0002](./adr/0002-fastify-api-v1.md),
[0003](./adr/0003-mongoose-and-gridfs.md), [0004](./adr/0004-mongo-jobs-no-redis.md),
and [0005](./adr/0005-pino-logging.md).

**Logging shape:** Pino JSON lines use level **labels** (`info` / `warn` / …), ISO-8601
`time`, and omit `pid` / `hostname`. Standalone mode writes console + rotating
`backend/logs/api.log` on the **main thread** (not a worker transport) so those
formatters apply to every sink. Request-scoped lines bind `method` and path-only `url`.

Three participants. Concurrency in this slice is **async I/O inside each Node process**,
plus a **dedicated worker process** for heavy ingest/index work. There is no separate
CodeGraph daemon and no Node `worker_threads` yet. In production the **browser talks to
one Fastify process** that serves both `/api/v1` and the built SPA (`frontend/dist` via
`@fastify/static`); there is no separate frontend Node server. Local development still
runs Vite as a separate HMR process that proxies `/api` to the API.

**Deploy topology (API):** multiple hosts, each running the API under **PM2 cluster mode**
(several Node workers per host). All workers share the same MongoDB replica set. Cross-request
coordination that must be fleet-wide (notably **idempotency keys**) is stored in Mongo — not
in process memory. **In-app rate limiting is not used** (per-process counters would be wrong
across workers/hosts; Redis is out of scope — ADR 0004). Optional request limits belong at the
load balancer / edge if operators need them.

```text
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React)                                                │
│  Talks only to the API host (JSON/SSE under /api/v1; SPA assets │
│  from the same origin in production). Never to the LLM host, MongoDB, │
│  CodeGraph, or the worker.                                      │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS  /api/v1  (+ static SPA in prod)
                             │ JSON (CRUD)  ·  SSE (chat)
                             │ (optional LB / edge rate limits)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  API hosts × N — each: PM2 cluster → Fastify (`backend/src/index.js`) │
│                                                                 │
│  Fast path: JWT, RBAC, CRUD, enqueue a job, open an SSE stream  │
│  Chat: run the LangGraph workflow in this same process          │
│  Production: also serves `frontend/dist` (SPA + hashed assets)  │
│  Reads: CodeGraph (read-only) + MongoDB + OpenAI-compatible LLM │
│                                                                 │
│  Does not poll jobs, unpack source trees, or rebuild the index. │
└───────┬──────────────────┬───────────────────┬──────────────────┘
        │                  │                   │
        │ MongoDB          │ disk (read)       │ HTTP /v1
        ▼                  ▼                   ▼
┌───────────────┐  ┌──────────────┐   ┌─────────────────┐
│ MongoDB 8+    │  │ Project      │   │ OpenAI-compat   │
│ + GridFS      │  │ workspace    │   │ LLM (/v1)       │
│ + jobs queue  │  │ + .codegraph │   └─────────────────┘
│ + idempotency │  └──────▲───────┘
└───────▲───────┘         │
        │ claim           │ write tree + index
        │                 │
┌───────┴─────────────────┴───────────────────────────────────────┐
│  Worker process — (`backend/src/worker/index.js`)               │
│                                                                 │
│  Polls Mongo `jobs`, claims one, heartbeats while running       │
│  Unpacks source, indexes documents, git fetch, builds CodeGraph │
│  Own PID and event loop — deployable separately from the API    │
└─────────────────────────────────────────────────────────────────┘
```

**Why two Node processes?** Indexing a large repo can take minutes and burn CPU/disk.
HTTP handlers must stay free for login, CRUD, and chat. Same pattern as “API + Sidekiq /
Bull worker”, except the queue is a **MongoDB `jobs` collection**, not Redis.

### How CodeGraph is loaded

CodeGraph is a library import, used in whichever process needs it:

| Who | Process | Access | What happens |
|-----|---------|--------|----------------|
| Chat, search, file browse | API | **Read lease** on `{orgId}/{projectId}/` | Function call → read `.codegraph/` SQLite on disk |
| Ingest, sync, recovery | Worker | **Writer lock** (one writer per project) | Function call → `indexAll` / `sync`. Filesystem auto-watch is **off**. |

The API and worker **do not** call each other over HTTP. They share **MongoDB** (jobs and
domain documents) and the **encrypted workspace directory** on disk.

A **read lease** / **writer lock** is the same idea as “don’t query an index while it is
being rebuilt”: readers wait until health is `ready` or `partially_available` and no writer
is active.

---

## 3. What lives where

```text
API process
  Fastify routes: JWT access token → request.principal { userId, orgId, roleIds, sessionId }
    (verify signature/iss/aud/exp, load active user, reject if passwordUpdatedAt > iat,
     load login session by sid — must be open (not logged out / revoked / expired); org never taken from path/query/body)
  Global authorize preHandler (ADR 0015): routeAccess public | authenticated | requiredPermissions
    → resolve effective permissions from roles (org-scoped; built-ins from code catalog)
  Project routes (ADR 0020): routeAccess authenticated → requireProjectPermission
    → resolveProjectPermissions (org ∪ projects.members overlay; 404 when not visible)
  Chat: LangGraph + SSE
  Before every model call: token budgeter
  Tools Node actually runs: explore_code, search_documents, read file/doc slices, abstain

Worker process
  Claim jobs (`findOneAndUpdate` pending→running), heartbeat lease refresh, reclaim
  stuck jobs (lease sweeper), graceful drain on shutdown
  Per-project writer serialization via `project_job_locks` (ADR 0022)
  One knowledge/sync job at a time per project
  Ingest stages S0–S6 (see §5)
  Scheduled git sync (default every 30 minutes)

MongoDB
  HTTP APIs that write two or more domain collections use one Mongo transaction
  (ADR 0031). Audit, idempotency, and GridFS bytes stay outside that transaction.
  Orgs (`aclVersion` for project ACL cache), users (`roleIds`,
  `projectAccessMode`: all | selected | none), roles, login sessions (embedded refresh hashes),
  projects (`lifecycleStatus`, `knowledgeHealth`, `sourceConfig`, `counts`, `settings`,
  embedded `members[]` ACL overlay; soft-delete via `status: 'A'|'D'`)  Source versions/files, document sections (text index), knowledge metadata
  Jobs (`jobs` with embedded `events[]` timeline; Phase 20 read APIs; Phase 21 worker
  claim — ADR 0004)
  Project job locks (`project_job_locks`; one live `project_writer` lock per project —
  ADR 0022)
  Conversations (`ownerUserId`, `title`, `titleSource`, `searchText`,
  `lifecycleStatus` active|archived, `archivedAt`, `lastMessageAt`, `messageCount`;
  text index `conversation_search_text` on `title` + `searchText`),
  messages (`conversationId`, `role`, `content`, `messageStatus`),
  clarifications, summaries
  Audit, in-app notifications, usage, idempotency keys
  GridFS: accepted source/doc bytes (not node_modules, not images)

Encrypted workspace on disk (current graph only)
  {orgId}/{projectId}/
    materialized source tree (accepted paths)
    .codegraph/   SQLite structural index
  Older graphs are not kept. Mongo `KnowledgeVersion` is metadata about the current one.
```

Every Mongo query and every workspace path is scoped to
`orgId + projectId + status: 'A'` (and the current knowledge version on retrieval).
Conversation reads also require `ownerUserId` of the caller (ADR 0027) until an
explicit share feature exists. Soft-delete is `status: 'D'`. Lifecycle uses other
fields (`lifecycleStatus`, `jobStatus`, `knowledgeHealth`, …).

**Not in this slice:** Redis/BullMQ, S3, an embedding service, a reranker, a standalone
CodeGraph service, Node `worker_threads`, live queries against the customer app database.

---

## 4. How a request is handled

```text
Client request
    │
    Fastify: authenticate, validate, authorize
    │
    ├── Fast CRUD / search / preview
    │     → Mongo / GridFS / CodeGraph read → 2xx
    │
    ├── Start ingest or git sync
    │     → insert Job (pending) → 202 { jobId, sourceVersionId }
    │       worker claims it later
    │
    └── Chat message
          ├── index currently updating/recovering → save message queued, 202
          ├── index failed → structured retryable error
          └── index ready or partial → open SSE, run LangGraph
```

The OpenAI-compatible LLM sits behind a **bounded inference queue** in
`backend/src/modules/conversation/llm.js` (API process, **per worker** — not fleet-wide).
Queue concurrency is `LLM_QUEUE_MAX_CONCURRENCY` from `npm run measure-llm-host`
(env). Depth (`INFERENCE_QUEUE_MAX_DEPTH = 8`) is
backpressure, not a guessed host-capacity number.
CodeGraph telemetry is off everywhere (set in-process by the CodeGraph adapter before
library import: `CODEGRAPH_TELEMETRY=0` and `DO_NOT_TRACK=1` — not via `.env`).

---

## 5. Ingest — source becomes knowledge

The API **accepts** the upload or repo connection. The worker **indexes**. The HTTP
request must not wait for indexing to finish.

```text
UI  POST ZIP/files  or  connect repo + branch
        │
        ▼
API     JWT + permission (upload / connect)
        Validate zip (integrity, zip-slip, allowlist) via the exclusions engine
          (Phase 23: inspectZip + summarizeInspection; ruleset id exclusions.v1)
        Stream entries: skip junk BEFORE writing GridFS
          skip: node_modules/, .git/, dist/, build/, coverage/, images, …
          accept_excluded_from_graph: allowlisted files > 1 MiB (stored, not graphed)
          nothing useful left → 400, ask for a cleaner upload
        Insert SourceVersion, SourceFile rows, Job(pending)
        Return 202 { sourceVersionId, jobId }

        │  (async)
        ▼
Worker  Atomically claim job  pending → running
        S0  validate_upload (re-check recorded metadata / empty set)
        S1  store_files — reconcile GridFS vs SourceFile rows (missing/corrupt → fileState;
            API already wrote accepted bytes in Phase 24 — not a second full store)
        S2  exclude_apply — record exclusions (size, leftover ignores)
        S3  materialize_docs — recreate workspace; split docs into searchable sections
        S4  codegraph_update — CodeGraph write under ADR 0022 project_job_locks **and**
            an in-process adapter writer mutex; full `indexAll` or in-place `sync`; validate;
            stash `graphIdentity` on the stage checkpoint cursor for S5
        S5  knowledge_publish — publish KnowledgeVersion (ready | partially_available | failed)
        S6  finalize — finish job + project lifecycle
```

Any file excluded from the graph forces knowledge health **`partially_available`**.
The project is not “knowledge ready” unless S5 succeeded.

**Re-upload:** new `SourceVersion`. Diff against the last **published** version by
`path + sha256` (persisted on `sourceChangeSummaries`). Unchanged docs skip re-parse;
S3 keeps those workspace files and copies their sections; S4 `sync`s changed paths
(or the full tree when paths were removed). Then S5 under the same writer lock.

**Re-ingest:** `POST /projects/:projectId/sources/:sourceVersionId/reingest` creates a
new `jobType: reingest` job on the same GridFS bytes and rebuilds S0–S6 without skip
paths. Retry of a failed job is a different verb and reuses the same Job (ADR 0023).

**Git sync:** every 30 minutes per connected project (skipped if a sync or ingest
is already running). Worker handler `repo_sync` (`exclusiveScope: none`) looks up
the branch HEAD, downloads a provider zip archive (ADR 0026), and enqueues
`ingest` (S0–S6). Auth/network failure **before** bytes persist leaves current
Q&A usable. Same `commitSha` → no-op. Manual `POST .../repositories/sync`
enqueues the same job.

Failed jobs are kept. Retry resumes from a checkpoint (or re-runs the full pipeline from
`validate_upload` against stored bytes when a full rebuild is required) and reuses the same
Job document; it must not start a second writer on the same project. Cancel is cooperative:
pending/retrying jobs cancel immediately, running jobs set `cancelRequestedAt` and stop at the
next stage boundary. A sweeper requeues or fails jobs whose heartbeat expired.

---

## 6. Chat — question becomes a grounded answer

### 6.1 HTTP / SSE (API process)

`POST /api/v1/conversation/chatStream/streamMessage/:projectId/:conversationId` with
`Accept: text/event-stream`.

```text
 1  Browser     POST { content }
 2  API         JWT → org, user; permission chat.ask; project membership
 3  API         Load conversation + knowledge health
 4  API         If index is updating/recovering:
                  save Message (queued) → 202 { messageId, jobId }  STOP
                If index failed → KNOWLEDGE_UNAVAILABLE  STOP
 5  API         Save Message (accepted); open SSE
 6  API         Event `status` { accepted, knowledgeHealth }
 7  API         Load chat context from Mongo only (not the repo) via
                  conversation `buildConversationContext`: recent turns,
                  summary, pinned facts, prior evidence snapshots
 8  LangGraph   Start/resume the workflow in this same Node process
 9–16           See §6.2; stream `delta` / `clarification` / `evidence` / `done`
```

The worker is **not** on this path unless the graph is updating (step 4). The
OpenAI-compatible LLM is the only network hop for model inference. CodeGraph and
LangGraph are in-process calls.

If the browser disconnects mid-stream (including Stop), the API aborts the in-flight graph
via `AbortSignal` and persists the assistant as `interrupted` (partial content kept when
available). The UI reloads by conversation messages and may Retry. See ADR 0037.

### 6.2 LangGraph workflow

Every model call: assemble the exact messages → count tokens for the **active model**
(`backend/src/modules/conversation/contextBudgeter.js`) → compact, or fail closed →
`conversation/llm.js` enqueue (per-worker, concurrency 1) → `provider.chat`.
Capacity comes from required `LLM_CONTEXT_CAPACITY`. The artifact id is the
configured model id after the startup `GET /models` probe (not a code constant). Missing tokenizer /
artifact mismatch → `CONTEXT_ACCOUNTING_UNAVAILABLE`. Still over after compaction →
`CONTEXT_BUDGET_EXCEEDED` (clarify or abstain). Never send an unmeasured prompt.

```text
                 UNDERSTAND          “What is the user asking? Do we need
                      │               clarification? Do not answer yet.”
         ┌────────────┼────────────┐
         ▼            ▼            ▼
   CLARIFY_SET   AGENT_TOOLS    ABSTAIN_EARLY
   pause for UI  tool loop      not enough to proceed
                      │
                      ▼
                DRAFT_ANSWER         stream tokens to the UI
                      │
                      ▼
                VERIFY_ANSWER        citations must resolve to real evidence
                      │
                      ▼
                PERSIST + DONE       Message, evidence[], usage, summary
```

**UNDERSTAND** (implemented in `backend/src/modules/conversation/chatGraph.js`) returns
JSON (`rewrittenQuestion`, `needsClarification`, `clarificationQuestions[]`,
`route`: `retrieve` | `abstain_early`). It does not answer the project question.
Private model reasoning is off for this node (`enableThinking: false`).

**CLARIFY_SET:** one SSE `clarification` payload with the full question list
(`messageId` = assistant id, `clarificationSetId`, `roundIndex`, `questions[]`).
Sets are persisted in `clarificationSets` for refresh. The UI asks them one at a
time locally, then POSTs **all** answers once to
`POST /conversation/clarification/answer/:projectId` with body
`{ conversationId, messageId, clarificationSetId, answers }` and
`Accept: text/event-stream` (same SSE events as ask). The workflow resumes
from a Mongo **`chatCheckpoints`** snapshot (`threadId` =
`{orgId}:{conversationId}:{assistantMessageId}`) at **UNDERSTAND** with answers bound.
At most one extra clarification round (two sets total).

**AGENT_TOOLS** (every tool is scoped to org + project + current knowledge version +
active rows):

| Tool | Backing store | Uses the LLM? |
|------|---------------|---------------|
| `explore_code` | CodeGraph read → symbols, paths, snippets | No (model only *chooses* the tool) |
| `search_documents` | Mongo text index on document sections | No |
| `list_documents` | Source metadata, paginated | No |
| `read_document_slice` | GridFS / materialized file, heading or line range | No |
| `read_file_slice` | Same, for code/config | No |
| `abstain` | Stop; do not invent a code answer | No |

Reject stale, cross-project, unlocated, or oversized tool results. Surviving snippets
go through `prepareModelInput` **before** they enter graph state. Evidence ids are
run-scoped (`ev_01`, `ev_02`, …). Slice tools reuse the same `loadSourceFileSlice`
helper as `GET …/files/slice`.

**DRAFT** (phase 49): rewritten question, short chat history, **only** accepted tool
results (with ids), and grounding rules. `streamText` with bounded thinking; answer
tokens only via `onDelta` (phase 50 → SSE `delta`).

**VERIFY** (phase 49): deterministic citation / path / `knowledgeVersionId` checks first;
LLM verify only for remaining ambiguous claims. Empty evidence → abstain. Fail with revise
budget (`MAX_VERIFY_REVISE = 1`) → AGENT_TOOLS once. Fail exhausted → abstain or grounded
partial. **PERSIST** updates the pending assistant `Message` (evidence snapshots,
`supportLevel`, usage, `durationMs`, `modelId`, `trace` for §146) — no separate
`responseTraces` collection.

**Context budget** (every node that calls the model):

```text
validated context capacity
  − reserved output tokens
  − system + tool-schema tokens
  = maximum input we may send
```

If over budget, shrink in this order: keep system rules, current question, clarification
answers, pinned facts → replace older turns with a saved summary → drop lower-ranked
excerpts (keep source ids) → shrink excerpts at natural boundaries → still over →
clarify or abstain.

There is no fixed “max tool rounds”. The run has cumulative token, tool-byte, call-count,
and wall-time budgets from `npm run measure-llm-host` (env keys `LLM_RUN_MAX_*`). These are
**not** the same as per-prompt `LLM_CONTEXT_CAPACITY`. Hitting any enforced limit ends
AGENT_TOOLS with `budgetExhausted` on graph state.

Follow-up questions reuse prior `evidence[]`. After a successful re-index, chat uses the
**new** current graph; old messages keep their evidence snapshots; the UI is warned.
We do not keep historical graphs to browse.

**Edit a user message:** one thread. Update that message; soft-delete later messages
(`status: 'D'`); rerun this flow. No conversation branches.
Routes (ADR 0036): `POST /api/v1/conversation/chatStream/editMessage/:projectId/:conversationId/:messageId`
(atomic edit + SSE / 202 queue) and
`POST /api/v1/conversation/chatStream/retryMessage/:projectId/:conversationId/:messageId`
(latest failed/interrupted assistant). Both require `Idempotency-Key`.

---

## 7. Indexing vs chat (same project)

One CodeGraph **writer** per project. Cross-job serialization uses `project_job_locks`
(ADR 0022). Inside the worker (and later the API for read leases), the CodeGraph adapter
also holds an in-process per-project writer mutex around `indexAll` / `sync`. Chat/search/browse
use `assertKnowledgeReadable` (Phase 28) and take a **read lease** only when health is `ready`
or `partially_available` and no writer is active.

```text
t0  graph ready (source version N)
t1  ingest job claimed → lifecycle updating + knowledgeHealth updating (Q&A queues);
    first ingest (no currentKnowledgeVersionId) → Q&A deny until publish
t2  worker updates the index in place (S3–S4); writer lock also queues Q&A
t3a success → S5/S6 publish ready or partially_available → gate allows
t3b temporary S4 fail → same-job rematerialize this source version + indexAll (bounded)
    exhaust → knowledge failed; gate denies KNOWLEDGE_UNAVAILABLE
```

Git/auth failure **before** the graph is mutated does not disable Q&A (Phase 32). Queue wait
has a configured expiry (Phase 51).

During writer/recovery, code browse returns “updating / unavailable”, never a stale graph.
Graph-excluded files may still be previewed when authorized; they must be labeled excluded
and must not be shown as graph-derived knowledge.

---

## 8. Search, browse, preview

Same tenant isolation as chat tools.

Browse routes under `/api/v1/knowledge/knowledge/*` (`getIndex`, `getSummary`,
`listWorkflows`, `listApis`, `listSymbols`, `getHealth` + `:projectId`) require
`knowledge.browse` **or** `knowledge.view`.
They resolve the project's **current** knowledge version only and read CodeGraph through a
read lease. Gate `allow` returns HTTP `200` with `{ state: "ready" }` plus payload.
Gate `queue` / writer or a missing index that cannot be leased returns `200`
`{ state: "updating"|"unavailable", items: [] }` — never a stale graph. `404` / `403` /
`400` are unchanged. Unexpected crashes stay `INTERNAL_ERROR` via the global handler.

| Endpoint (shape) | Reads |
|------------------|--------|
| `GET /projects/:id/search` | CodeGraph (code/symbols/apis) + Mongo text search (docs). Same `200 { state }` wrapper as browse; docs kept when the graph lease fails and the gate allows. |
| `GET /projects/:id/knowledge` | Facets present on the current graph + docs |
| `GET /projects/:id/knowledge/summary` | Extractive docs + graph metadata (no LLM) |
| `GET /projects/:id/knowledge/workflows` | Workflow nodes when the library exposes them |
| `GET /projects/:id/knowledge/apis` | `getRoutingManifest` / `route` nodes |
| `GET /projects/:id/knowledge/symbols?q=` | `getNodesByNamePrefix` / `searchNodes` |
| `GET /projects/:id/knowledge/health` | Published health + exclusion count |
| `GET /projects/:id/files` | Current `SourceFile` metadata + excluded-from-graph labels |
| `GET /knowledge/sourcePreview/readSlice/:projectId` | GridFS bytes, line-bounded and capped; `truncated` when a cap applies (`sources.preview`) |
| `GET /knowledge/sourcePreview/getMetadata/:projectId` | File metadata + excluded-from-graph labels for preview |
| `GET /projects/:id/knowledge/updates/latest` | Latest computed `sourceChangeSummaries` row (file counts only; impact fields null) |
| Chat “ask about this” | FE chip via `searchAttachment` navigation state; send prepends readable context into `content` |

Chat and knowledge share the preview drawer under `frontend/src/shared/source-preview/` (Phase 57).

---

## 9. Connections (reference)

Mechanisms below match the accepted stack ADRs
([index](./adr/README.md)): Fastify [`0002`](./adr/0002-fastify-api-v1.md), Mongoose/GridFS
[`0003`](./adr/0003-mongoose-and-gridfs.md), Mongo jobs [`0004`](./adr/0004-mongo-jobs-no-redis.md).

| From | To | Mechanism | Carries |
|------|----|-----------|---------|
| React | Fastify | Same-origin HTTPS JSON (`/api/v1`); chat uses SSE; production also loads the SPA from this host | CRUD, job status, SSE events, static UI |
| Fastify | MongoDB | Mongoose | Domain docs, text search, jobs, chat, audit/usage |
| Fastify | GridFS | MongoDB GridFS | Accepted source/doc bytes |
| Fastify | LangGraph | in-process library | Chat state machine; the route handler still owns SSE |
| Fastify | CodeGraph | in-process, **read lease** | Explore / `buildContext` on the current workspace |
| Fastify | OpenAI-compatible LLM | HTTP `/v1` via `conversation/llm.js` (`ai` + `@ai-sdk/openai`, `provider.chat`) | Budgeted generate / stream |
| Fastify | GitHub/GitLab | HTTPS REST (probe + persist the connection; encrypted PAT nested) | Identity, branches, default branch, encrypted PAT |
| Fastify | Worker | **only** by inserting a `Job` row | `202 { jobId }` — no RPC |
| Worker | MongoDB | atomic claim | Jobs, source/knowledge metadata |
| Worker | GridFS | read | Rebuild the tree from accepted bytes |
| Worker | workspace | local encrypted volume | Source tree + `.codegraph/` SQLite |
| Worker | GitHub/GitLab | HTTPS archive API (zipball / archive.zip) | `repo_sync` only; credentials decrypted in memory |
| Worker | CodeGraph | in-process, **writer lock** | `indexAll` (first time) or `sync` |

SSE events the UI handles: `status`, `delta` (token text), `clarification`, `evidence`,
`done`, `error`.

---

## 10. Cross-cutting

| Concern | Where |
|---------|--------|
| Rate limit | Not in the Node API (PM2 multi-host). Optional at LB/edge only |
| Idempotency | `Idempotency-Key` + Mongo `idempotencyRecords` (shared across PM2 workers/hosts) |
| Audit | append-only `AuditEvent`; curated `<domain>.<verb>` action catalog; best-effort writer (ADR 0016); no secrets, no raw source, no full chat |
| Notifications | in-app only in this slice (knowledge/sync/attention) |
| Usage | recorded `projectActivities` only (aggregate on read; question/token kinds from chat finalize) |
| Retention | scheduled worker; default keep last 3 ready source versions (see solution §12.3) |

### Errors and correlation

- **Catalog:** [`backend/src/platform/errorCatalog.js`](../backend/src/platform/errorCatalog.js) is the
  only place an error code may be defined. Each code maps to `class`, HTTP status,
  `retryability`, and a stable English default message (see [ADR 0010](./adr/0010-structured-error-envelope.md)).
- **Envelope:** `{ error: { code, class, retryability, message, reference, details? } }`.
- **Correlation:** Fastify `request.id` is `REQ-` + 32 hex; echoed as `X-Correlation-Id` on
  every response and as `error.reference`. Inbound client ids are ignored. Services and audit
  writers receive the id as an explicit argument (`request.id` or `job.correlationId`).
- **Retry:** only `temporary` codes are auto-retryable (`retryPolicy.js`); permanent /
  `user_action_required` never increment an auto-retry counter.
- **SSE:** after headers are sent, handlers emit a terminal `error` event built by
  `streamErrors.js` (same five fields); the global handler does not write stream frames.
