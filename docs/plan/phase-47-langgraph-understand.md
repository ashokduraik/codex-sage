# Phase 47 — LangGraph workflow: understand, routing & checkpoints

- **Layer:** BE
- **Depends on:** Phase 44 (summary, pinned facts, context metrics), Phase 45 (LLM client,
  bounded inference queue)
- **Unblocks:** Phase 48, 52
- **Size:** 1–2 days
- **Requirements covered:** backend §51, §52, §56, §58; backend/solution.md §5.2 node A, §5.4;
  docs/architecture.md §6.2 (UNDERSTAND branch), §9 (LangGraph in-process)

## 1. Goal

After this phase a **LangGraph state machine** exists for the first segment of FLOW B: load run
context, run **UNDERSTAND** with model private reasoning **off** (`enableThinking: false`), parse a
structured routing decision, optionally enter **CLARIFY_SET** (interrupt + Mongo checkpoint), or
route toward retrieval / early abstain. The graph exposes **hooks** for observable stages
(`understanding_question`, etc.) that phase 50 wires to SSE — this phase does not open HTTP streams.
Checkpoints persist in Mongo so clarification resume and client disconnect recovery have a durable
thread id. You can see it working in integration tests: invoke the graph with a fixture question →
state contains `rewrittenQuestion` and `route`; a `needsClarification: true` fixture interrupts with
a full clarification set shape ready for phase 52.

## 2. Why this phase is here

Solution §5.2 separates **understanding** from tool loops and drafting. Phase 45 delivers the LLM
client; phase 44 delivers the conversation context bag (summary, pins, metrics). Without a graph shell
and UNDERSTAND node, phase 48 would mix routing, tools, and persistence in one untestable handler. This
phase must precede 48 because the tool loop assumes `rewrittenQuestion` and route enums already exist.
It must precede 52 because CLARIFY_SET **interrupt payload shape** is defined here; HTTP answer POST
and resume are 52's job. SSE event emission stays in **phase 50** — only callbacks/hooks are registered
here.

## 3. Scope

### In scope

- Install **`@langchain/langgraph`** (and **`@langchain/core`** if required by the graph API) at
  implementation time per `dependency-versions.mdc` — **do not pin versions in this document**.
- Graph module under **`conversation/`**: state, nodes, conditional edges from UNDERSTAND.
- **UNDERSTAND** node: `buildConversationContext` (44); budget via `generateText` / `prepareModelInput`;
  `enableThinking: false`; validate structured JSON (Zod).
- Structured output: `rewrittenQuestion`, `needsClarification`, `clarificationQuestions[]`
  (`single_select` | `multi_select` | `free_text`), `route` (`retrieve` | `abstain_early`).
  Clarification is **`needsClarification: true`**, not a `route` value.
- **CLARIFY_SET**: interrupt + checkpoint; resume input shape — **no** HTTP route.
- **ABSTAIN_EARLY**: terminal early path before tools (hand off to 49).
- Mongo checkpointer on collection **`chatCheckpoints`** (see §5; needs schema approval).
- Stage hooks: `onStage({ stage, data })` for phase 50.
- Record measured context metrics (no fabricated numbers).

### Out of scope (owner phase)

- AGENT_TOOLS loop and run budgets — **phase 48**.
- DRAFT, VERIFY, PERSIST — **phase 49**.
- `POST .../messages` SSE, knowledge gate, idempotency — **phase 50**.
- Clarification HTTP `POST .../answers` — **phase 52**.
- Tool registry implementations — **phase 46** (graph may reference route only).
- Bounded thinking for DRAFT — **phase 49**.

## 4. Design

### 4.1 Process placement

LangGraph runs **in the API process** on the chat request path — not in the worker.
`compileChatGraph({ checkpointer, onStage })` is callable from phase 50’s service.

### 4.2 Graph topology (this phase)

```text
START → load_context
     → UNDERSTAND
            ├─ needsClarification → CLARIFY_SET → INTERRUPT (checkpoint)
            ├─ route retrieve     → END (phase 48 adds AGENT_TOOLS on this edge)
            └─ abstain_early      → ABSTAIN_EARLY → END (hand off to 49 persist)
```

One [`chatGraph.js`](../../backend/src/modules/conversation/chatGraph.js). Phase 48 extends the same
file; this phase ends on `retrieve` (no `NOT_IMPLEMENTED` stubs).

### 4.3 UNDERSTAND node

**Prompt intent:** rewrite the user question using conversation context; decide if clarification is
needed; **do not answer the project question yet**.

**LLM call:** `generateText({ purpose: 'understand', enableThinking: false, outputSchema })`.

**On success:** write decision fields; `onStage({ stage: 'understanding_question' })`; accumulate
measured token usage.

**On validation failure:** one repair retry; still invalid → `route: 'abstain_early'` (never silent
default to `retrieve`).

### 4.4 CLARIFY_SET interrupt shape

When `needsClarification: true`:

1. Normalise question ids (`q1`, `q2`, …).
2. Build interrupt value:

```text
ClarificationSet
├── clarificationSetId
├── questions[]: { id, type, prompt, options? }
├── issuedAt
└── roundIndex              0 = first set; at most one follow-up (roundIndex 1)
```

3. `interrupt(clarificationSet)`; checkpoint to Mongo.
4. `onStage({ stage: 'awaiting_clarification' })`.

**Resume input (internal, phase 52 later):**

```text
{ clarificationSetId, answers: Record<questionId, string | string[]> }
```

**Locked:** graph resumes at **UNDERSTAND** with answers bound. Max two sets enforced in the graph
(`roundIndex` 0 then 1), **shared** with tool-loop `ask_clarification` (ADR 0040). A third
UNDERSTAND clarify attempt forces early abstain; an exhausted tool-loop ask finishes retrieval
instead.

### 4.5 Checkpointer

Thin custom Mongo saver (tenant `orgId` + row `status` `A`/`D`):

- `threadId` = `{orgId}:{conversationId}:{assistantMessageId}`
- Store channel values + interrupt metadata; **no** private reasoning text
- TTL / cleanup: phase 60 retention

### 4.6 Initial graph state

```text
ChatGraphState
├── scope: orgId, projectId, userId, conversationId, userMessageId, assistantMessageId,
│          knowledgeVersionId, correlationId
├── question, rewrittenQuestion
├── clarificationSet, clarificationAnswers
├── route, toolResults (empty until 48)
├── context segments / summary / pins (from 44)
├── metrics + cumulative token / tool-byte counters, startedAt
└── draftAnswer, verifyResult (null until 49)
```

## 5. Data model changes (needs explicit user approval before model code)

**Collection purpose:** When a chat answer run pauses (clarification) or the client disconnects,
Node must resume the **same** LangGraph run. `chatCheckpoints` stores those durable snapshots.
It is **not** the user-visible clarification Q&A document (phase 52), not message content, and not
private model reasoning.

**Collection / model:** `chatCheckpoints` / `ChatCheckpoint`

| Field | Type | Required | Purpose (why it exists) |
| --- | --- | --- | --- |
| `orgId` | ObjectId | yes (base) | Tenant isolation; resume must never load another org’s run |
| `status` | `'A'` \| `'D'` | yes (base) | Soft-delete; list/resume only active rows |
| `createdBy` / `updatedBy` | ObjectId \| null | base | Audit actors (system writes may be null) |
| `createdAt` / `updatedAt` | Date | base | Ordering and later retention |
| `threadId` | string | yes | LangGraph thread key: `{orgId}:{conversationId}:{assistantMessageId}` |
| `checkpointNs` | string | yes, default `''` | LangGraph namespace; empty unless a second graph shares a thread |
| `checkpointId` | string | yes | Snapshot id within the thread (library-generated) |
| `parentCheckpointId` | string \| null | no | Previous snapshot — history chain for resume |
| `checkpoint` | Mixed | yes | Serialized graph channels at this step; no thinking/CoT |
| `metadata` | Mixed | no | Small hints: projectId, conversationId, assistantMessageId, interrupt pending |

**Indexes:**

- Unique partial `{ orgId, threadId, checkpointId }` where `status: 'A'`
- List/resume partial `{ orgId, threadId, createdAt: -1 }` where `status: 'A'`

**Out of this collection:** canonical clarification answers (phase 52), SSE payloads, UI evidence.

**Approval gate:** do not write `backend/src/models/chatCheckpoint.model.js` until the user approves
this exact list in the current conversation.

No `Message` schema change in this phase.

## 6. API contract (internal — no public HTTP)

```json
{
  "compileChatGraph": "(deps) => CompiledGraph",
  "invokeChatGraph": {
    "input": "threadId + ChatGraphState partial",
    "output": "state | Interrupt<ClarificationSet>"
  },
  "resumeChatGraphFromClarification": {
    "threadId": "string",
    "clarificationSetId": "string",
    "answers": "Record<string, string | string[]>"
  },
  "understandDecisionSchema": {
    "rewrittenQuestion": "string",
    "needsClarification": "boolean",
    "clarificationQuestions": [{
      "id": "string",
      "type": "single_select | multi_select | free_text",
      "prompt": "string",
      "options": ["string"]
    }],
    "route": "retrieve | abstain_early"
  },
  "stageHook": "(event: { stage: string, data?: object }) => void"
}
```

Stages this phase: `understanding_question`, `awaiting_clarification`, `abstain_early`.

## 7. Configuration & environment variables

**None** for graph topology. LLM env remains phase 45. Any saver tunables are named constants next
to the consumer.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/package.json` | Add `@langchain/langgraph`, `@langchain/core` at implementation (latest stable) |
| `backend/src/modules/conversation/chatGraph.js` (+ tests) | Compile, invoke, resume; UNDERSTAND / CLARIFY / ABSTAIN runners |
| `backend/src/modules/conversation/chatGraph.helper.js` | Only if over 1000 code lines (checkpointer overflow) |
| `backend/src/models/chatCheckpoint.model.js` | After schema approval |
| `backend/src/modules/conversation/llm.js` | `enableThinking` boolean (default false) |
| `backend/src/modules/conversation/index.js` | Export graph APIs + model list |

Do **not** add `backend/src/modules/chat/`.

## 9. Tests (≥ 80% line and branch)

### Unit

- UNDERSTAND schema rejects missing fields / invalid `route`.
- `enableThinking: false` on every UNDERSTAND `generateText` call.
- `needsClarification` enters CLARIFY_SET; `retrieve` does not set a clarification set.
- Hook throw does not corrupt checkpoint.
- Budget preflight failure → `CONTEXT_ACCOUNTING_UNAVAILABLE` without LLM call.
- Malformed JSON twice → `abstain_early`.

### Integration

- Interrupt → `chatCheckpoints` row with org-scoped `threadId`.
- Resume with answers → `clarificationAnswers` in state; re-enters UNDERSTAND.
- Wrong-org resume fails closed.

## 10. Definition of Done

- [x] `@langchain/langgraph` installed per dependency-versions; versions in lockfile only.
- [x] UNDERSTAND uses `enableThinking: false` and validated structured JSON.
- [x] CLARIFY_SET interrupt shape tested; no HTTP clarification route.
- [x] Mongo checkpointer persists and resumes (after schema approval).
- [x] Stage hooks only; no SSE inside graph nodes.
- [x] No AGENT_TOOLS, DRAFT, or VERIFY nodes.
- [x] No private reasoning stored or logged.
- [x] Lint/tests pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- ADR `docs/adr/0035-langgraph-mongo-checkpointer.md`.
- `docs/architecture.md` §6.2: conversation `chatGraph.js` + checkpoint purpose.
- `backend/solution.md` §5.4: resume at UNDERSTAND.
- `docs/data-model.md` when schema is approved.

## 12. Locked decisions (closed)

1. **Resume target:** UNDERSTAND again with answers bound.
2. **threadId:** `{orgId}:{conversationId}:{assistantMessageId}`.
3. **Checkpointer:** custom Mongo saver on `chatCheckpoints` (tenant + status); official package
   only as optional in-module adapter if latest + maintained at install time.
4. **Follow-up clarification:** max two sets enforced in the graph (`roundIndex` 0 then 1),
   shared with AGENT_TOOLS `ask_clarification` (ADR 0040).
5. **Prompt size / model id:** phase 05 / env; not blocking graph shape.
