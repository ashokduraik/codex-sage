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
│  from the same origin in production). Never to Ollama, MongoDB, │
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
│  Reads: CodeGraph (read-only) + MongoDB + Ollama over HTTP      │
│                                                                 │
│  Does not poll jobs, unpack source trees, or rebuild the index. │
└───────┬──────────────────┬───────────────────┬──────────────────┘
        │                  │                   │
        │ MongoDB          │ disk (read)       │ HTTP /v1
        ▼                  ▼                   ▼
┌───────────────┐  ┌──────────────┐   ┌─────────────────┐
│ MongoDB 8+    │  │ Project      │   │ Ollama          │
│ + GridFS      │  │ workspace    │   │ (model server)  │
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
     load session by sid — must be active/not revoked; org never taken from path/query/body)
  Global authorize preHandler (ADR 0015): routeAccess public | authenticated | requiredPermissions
    → resolve effective permissions from roles (org-scoped; built-ins from code catalog)
  Project routes (ADR 0020): routeAccess authenticated → requireProjectPermission
    → resolveProjectPermissions (org ∪ ProjectMember overlay; 404 when not visible)
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
  Orgs (`aclVersion` for project ACL cache), users, roles, memberships
  (`projectAccessMode`: all | selected | none), sessions (refresh-token families),
  projects (`lifecycleStatus`, `knowledgeHealth`, `sourceConfig`, `counts`, `settings`;
  soft-delete via `status: 'A'|'D'`), project_members (per-project ACL overlay)  Source versions/files, document sections (text index), knowledge metadata
  Jobs and job events (`jobs` / `job_events`; Phase 20 read APIs; Phase 21 worker claim —
  ADR 0004)
  Project job locks (`project_job_locks`; one live `project_writer` lock per project —
  ADR 0022)
  Conversations, messages, clarifications, summaries
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
Soft-delete is `status: 'D'`. Lifecycle uses other fields (`lifecycleStatus`, `jobStatus`,
`knowledgeHealth`, …).

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

Ollama sits behind a **bounded inference queue** so one chat cannot starve the machine.
How many concurrent model calls are safe is an evaluation result, not a guessed constant.
CodeGraph telemetry is off everywhere (`CODEGRAPH_TELEMETRY=0`).

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
        S4  codegraph_update — CodeGraph write (full index or in-place sync); validate
        S5  knowledge_publish — publish KnowledgeVersion (ready | partially_available | failed)
        S6  finalize — finish job + project lifecycle
```

Any file excluded from the graph forces knowledge health **`partially_available`**.
The project is not “knowledge ready” unless S5 succeeded.

**Re-upload:** new `SourceVersion`. Diff against the last successful version by
`path + sha256`. Unchanged docs skip re-index. Then S3–S5 under the same writer lock.

**Git sync:** every 30 minutes per connected project (skipped if a sync is already
running). Auth/network failure **before** the graph is touched leaves current Q&A
usable. Same `commitSha` → no-op. Changed SHA → new `SourceVersion`, same index path
as re-upload. Manual `POST .../repositories/sync` enqueues the same job.

Failed jobs are kept. Retry resumes from a checkpoint (or re-runs the full pipeline from
`validate_upload` against stored bytes when a full rebuild is required) and reuses the same
Job document; it must not start a second writer on the same project. Cancel is cooperative:
pending/retrying jobs cancel immediately, running jobs set `cancelRequestedAt` and stop at the
next stage boundary. A sweeper requeues or fails jobs whose heartbeat expired.

---

## 6. Chat — question becomes a grounded answer

### 6.1 HTTP / SSE (API process)

`POST /api/v1/conversations/:id/messages` with `Accept: text/event-stream`.

```text
 1  Browser     POST { content }
 2  API         JWT → org, user; permission chat.ask; project membership
 3  API         Load conversation + knowledge health
 4  API         If index is updating/recovering:
                  save Message (queued) → 202 { messageId, jobId }  STOP
                If index failed → KNOWLEDGE_UNAVAILABLE  STOP
 5  API         Save Message (accepted); open SSE
 6  API         Event `status` { accepted, knowledgeHealth }
 7  API         Load chat context from Mongo only (not the repo):
                  recent turns, summary, pinned facts, prior evidence snapshots
 8  LangGraph   Start/resume the workflow in this same Node process
 9–16           See §6.2; stream `delta` / `clarification` / `evidence` / `done`
```

The worker is **not** on this path unless the graph is updating (step 4). Ollama is the
only network hop for model inference. CodeGraph and LangGraph are in-process calls.

If the browser disconnects mid-stream, the run still finishes in Mongo (`completed` or
`failed`). The UI reloads the message by id.

### 6.2 LangGraph workflow

Every model call: assemble the exact messages → count tokens for the **active model** →
compact or fail with `CONTEXT_ACCOUNTING_UNAVAILABLE`. Never send an unmeasured prompt.

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

**UNDERSTAND** returns JSON (`rewrittenQuestion`, `needsClarification`,
`clarificationQuestions[]`, `route`). It does not answer the project question.

**CLARIFY_SET:** one SSE `clarification` payload with the full question list. The UI
asks them one at a time locally, then POSTs **all** answers once. The workflow resumes
from a Mongo checkpoint. At most one extra clarification round.

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
go through the token budgeter **before** they enter graph state.

**DRAFT** prompt: rewritten question, short chat history, **only** accepted tool
results (with ids), and grounding rules.

**VERIFY:** every non-trivial claim → an evidence id; path/lines exist; same knowledge
version. Empty evidence → abstain. Fail with budget left → retrieve/revise. Fail with
budget exhausted → abstain or a grounded partial answer.

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
and wall-time budgets from evaluation. Hitting any of them ends the run.

Follow-up questions reuse prior `evidence[]`. After a successful re-index, chat uses the
**new** current graph; old messages keep their evidence snapshots; the UI is warned.
We do not keep historical graphs to browse.

**Edit a user message:** one thread. Update that message; soft-delete later messages
(`status: 'D'`); rerun this flow. No conversation branches.

---

## 7. Indexing vs chat (same project)

One CodeGraph **writer** per project. Chat/search/browse take a **read lease** only when
health is `ready` or `partially_available` and no writer is active.

```text
t0  graph ready (source version N)
t1  version N+1 accepted → Q&A off; new questions saved as queued (202)
t2  worker updates the index in place
t3a success → publish ready or partial → queued questions resume on the new graph
t3b failure → Q&A stays off
    restore last successfully accepted tree, rebuild, validate
    then t3a, or fail the queue with retryable KNOWLEDGE_UNAVAILABLE
```

Git/auth failure **before** the graph is mutated does not disable Q&A. Queue wait has a
configured expiry.

During writer/recovery, code browse returns “updating / unavailable”, never a stale graph.
Graph-excluded files may still be previewed when authorized; they must be labeled excluded
and must not be shown as graph-derived knowledge.

---

## 8. Search, browse, preview

Same tenant isolation as chat tools.

| Endpoint (shape) | Reads |
|------------------|--------|
| `GET /projects/:id/search` | CodeGraph (code/symbols) + Mongo text search (docs) |
| `GET /projects/:id/knowledge/*` | Current graph metadata + on-demand bounded reads |
| `GET /projects/:id/files/slice` | GridFS / materialized bytes, capped |
| Chat “ask about this” | Resolve ids again under org/project/current version → evidence → budgeter → UNDERSTAND |

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
| Fastify | Ollama | HTTP `/v1` via `ai` SDK | Budgeted generate / stream |
| Fastify | Worker | **only** by inserting a `Job` row | `202 { jobId }` — no RPC |
| Worker | MongoDB | atomic claim | Jobs, source/knowledge metadata |
| Worker | GridFS | read | Rebuild the tree from accepted bytes |
| Worker | workspace | local encrypted volume | Source tree + `.codegraph/` SQLite |
| Worker | GitHub/GitLab | git fetch or API archive | `repo_sync` only; credentials decrypted in memory |
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
| Usage | recorded `UsageEvent` / rollups only |
| Retention | scheduled worker; default keep last 3 ready source versions (see solution §12.3) |

### Errors and correlation

- **Catalog:** [`backend/src/platform/errorCatalog.js`](../backend/src/platform/errorCatalog.js) is the
  only place an error code may be defined. Each code maps to `class`, HTTP status,
  `retryability`, and a stable English default message (see [ADR 0010](./adr/0010-structured-error-envelope.md)).
- **Envelope:** `{ error: { code, class, retryability, message, reference, details? } }`.
- **Correlation:** Fastify `request.id` is `REQ-` + 32 hex; echoed as `X-Correlation-Id` on
  every response and as `error.reference`. Inbound client ids are ignored. Services read the
  id via `AsyncLocalStorage` (`requestContext.js`) without threading it through every call.
- **Retry:** only `temporary` codes are auto-retryable (`retryPolicy.js`); permanent /
  `user_action_required` never increment an auto-retry counter.
- **SSE:** after headers are sent, handlers emit a terminal `error` event built by
  `streamErrors.js` (same five fields); the global handler does not write stream frames.
