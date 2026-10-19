# Chat stream & LangGraph — developer guide

How a user question becomes a grounded (or abstained) answer: **HTTP/SSE → LangGraph
nodes → tools → persist**. Written for engineers who are new to LangGraph.

For product topology and trust rules, see [`architecture.md`](./architecture.md) §6.
This doc mirrors **what the code does today**.

---

## 1. LangGraph in one minute (with a concrete example)

LangGraph is a **state machine**: named steps (nodes) run in order, each step can
change a shared bag of fields (state), and after some steps a function chooses the
next step (conditional edge). Think of it like a workflow engine, not like “call the
LLM once.”

We do **not** invent answers in the graph. Retrieval tools return evidence; VERIFY
checks citations; otherwise we clarify or abstain.

### 1.1 The six ideas — same example throughout

User asks: **“How does login work?”**  
One assistant message = one graph run, keyed by `threadId`
`{orgId}:{conversationId}:{assistantMessageId}`.

---

#### State — the shared notebook for this run

**State** is one object LangGraph keeps for the whole run. Every node can read it;
nodes return only the fields they change; LangGraph **merges** those into state.

After `invokeChatGraph` starts, state looks roughly like:

```js
{
  question: 'How does login work?',
  scope: { orgId, projectId, conversationId, assistantMessageId, … },
  route: null,
  toolResults: [],
  // … many other fields default to empty / zero
}
```

After the `understand` node finishes, the same notebook might be:

```js
{
  question: 'How does login work?',          // unchanged
  rewrittenQuestion: 'How does user login authentication work in this project?',
  needsClarification: false,
  route: 'retrieve',                         // UNDERSTAND decided this
  toolResults: [],                           // tools have not run yet
  // …
}
```

Nothing else in the process holds a second copy of “what we decided so far” for this
assistant message — **state is that copy**.

Defined as `ChatGraphState` in `chatGraph.js`.

---

#### Node — one step that updates the notebook

A **node** is a function: `(state) => partialUpdate`.

Example: `load_context` reads `state.scope`, loads chat history from Mongo, and
returns only what it adds:

```js
// conceptual — see runLoadContextNode
return {
  contextSegments: [/* recent turns */],
  summarySegment: {/* … */},
};
```

LangGraph merges that into state. Next node sees the updated notebook.

Our nodes have names like `understand`, `agent_tools`, `draft_answer`. Each name is
registered with `.addNode('understand', …)` in `compileChatGraph`.

---

#### Edge — “always go here next”

An **edge** is a fixed arrow: after node A, always run node B.

```js
.addEdge('load_context', 'understand')
// after load_context finishes → always run understand
```

```text
  load_context  ──edge──►  understand
```

No decision. History loaded? Always UNDERSTAND next.

---

#### Conditional edge — “look at the notebook, then pick”

A **conditional edge** is a function that reads state and returns a **string label**.
That label maps to the next node.

```js
.addConditionalEdges('understand', routeAfterUnderstand, {
  clarify_set: 'clarify_set',
  abstain_early: 'abstain_early',
  retrieve: 'agent_tools',      // label "retrieve" → node agent_tools
  reply_direct: 'reply_direct',
})
```

For **“How does login work?”**, UNDERSTAND set `route: 'retrieve'` and
`needsClarification: false`. Then:

```js
routeAfterUnderstand(state)  // returns 'retrieve'
// → LangGraph runs agent_tools next
```

If instead UNDERSTAND had set `needsClarification: true`:

```js
routeAfterUnderstand(state)  // returns 'clarify_set'
// → LangGraph runs clarify_set next
```

Same node (`understand`); **different next step** because state differs.

```text
                    understand
                         │
              routeAfterUnderstand(state)
           ┌─────────────┼─────────────┬──────────────┐
           ▼             ▼             ▼              ▼
      clarify_set   abstain_early  agent_tools   reply_direct
```

---

#### Interrupt — pause *inside* a node and return to HTTP

An **interrupt** is: “stop the graph here, give this value back to the caller, and
wait for a resume later.”

Clarify uses it in `clarify_wait`:

```js
function runClarifyWaitNode(state) {
  const clarificationSet = state.clarificationSet;
  const resumePayload = interrupt(clarificationSet); // ← pause here
  // lines below run only AFTER resume with the user's answers
  return { clarificationAnswers: resumePayload.answers, … };
}
```

What the user / HTTP sees:

1. Graph reaches `clarify_wait` → calls `interrupt(clarificationSet)`.
2. `invokeChatGraph` returns early with something like:

   ```js
   { __interrupt__: [{ value: { clarificationSetId, questions: […] } }] }
   ```

3. `chatStream.js` sees `__interrupt__`, writes SSE event `clarification`, marks the
   assistant `awaiting_clarification`, and **ends this HTTP request**.
4. The graph is **not** finished — it is frozen on that node.

Without interrupt, the HTTP handler would have to block until the user answered
(impossible across refresh / new request).

---

#### Checkpointer — save the notebook so pause/resume works

A **checkpointer** persists graph state (and “which node we paused on”) under
`thread_id`. We use Mongo (`createMongoChatCheckpointer` → collection
`chatCheckpoints`, ADR 0035).

| Without checkpointer | With checkpointer (what we do) |
| -------------------- | ------------------------------ |
| Interrupt loses everything when the request ends | State is saved at interrupt |
| Resume would have to re-run UNDERSTAND from scratch | Resume loads the same thread and continues `clarify_wait` |

Resume path (user answered the UI):

```text
  POST /conversation/clarification/answer
       → resumeChatGraphFromClarification({ threadId, answers })
       → checkpointer loads saved state for that threadId
       → clarify_wait continues with answers
       → conditional edge → understand again → …
```

Same `threadId` as the original ask — that is how LangGraph knows which notebook to
reload.

---

### 1.2 Tiny walkthrough (no clarify)

```text
  START
    │  edge
    ▼
  load_context     // writes contextSegments into state
    │  edge
    ▼
  understand       // writes route: 'retrieve' into state
    │  conditional edge → 'retrieve'
    ▼
  agent_tools      // appends toolResults (evidence) into state
    │  conditional edge → loop or draft_answer
    ▼
  draft_answer → verify_answer → persist_done → END
```

### 1.3 Tiny walkthrough (with clarify)

```text
  … → understand (needsClarification: true)
        │  conditional edge → clarify_set
        ▼
      clarify_set          // builds clarificationSet on state
        │  edge
        ▼
      clarify_wait
        │  interrupt(clarificationSet)
        │  checkpointer SAVES state
        │  HTTP gets __interrupt__ → SSE clarification → request ends
        │
        │  … user answers in UI …
        │
        │  HTTP resume with answers
        │  checkpointer LOADS state
        ▼
      clarify_wait continues → understand → …
```

---

## 2. File map (start here)


## 2. File map (start here)

```text
Browser
  frontend/src/features/chat/api/chatStreamApi.js     POST SSE + parse events
  frontend/src/features/chat/api/clarificationsApi.js  POST clarify answers (same SSE)

API route catalog
  backend/src/http/route.js
    POST /conversation/chatStream/streamMessage
    POST /conversation/chatStream/editMessage
    POST /conversation/chatStream/retryMessage
    POST /conversation/clarification/answer

HTTP + SSE orchestration (no graph logic)
  backend/src/modules/conversation/chatStream.js
    streamConversationMessageHttp → runChatStreamForExistingUser
    → invokeChatGraph / resume path hooks (onStage, onDelta, …)

LangGraph workflow
  backend/src/modules/conversation/chatGraph.js
    compileChatGraph, invokeChatGraph, resumeChatGraphFromClarification
    nodes: load_context, understand, clarify_*, agent_tools, …
    routers: routeAfterUnderstand, routeAfterAgentTools, …

  backend/src/modules/conversation/chatGraph.helper.js
    DRAFT / VERIFY / PERSIST / direct-reply runners
    Mongo checkpointer, Zod schemas, CLARIFICATION_MAX_ROUNDS, MAX_VERIFY_REVISE

Agent tools (scoped retrieval — not the LLM “answering”)
  backend/src/modules/conversation/agentTools.js
    listToolDefinitionsForSchema, executeTool

Supporting
  conversationContext.js   recent turns + summary for load_context
  llm.js                   generateText / streamText (+ inference queue)
  contextBudgeter.js       token fit before every model call
  runBudget.js             whole-run token / bytes / calls / wall-time caps
  clarification.js         persist open clarify sets; answer HTTP
  chatQueue.js             202 queue when knowledge is updating
```

**Thread id** (checkpoint key): `{orgId}:{conversationId}:{assistantMessageId}`  
Built by `buildChatGraphThreadId` in `chatGraph.helper.js`. Stored in Mongo
`chatCheckpoints` (ADR 0035).

---

## 3. End-to-end request flow

```text
  User types a question
           │
           ▼
  POST /conversation/chatStream/streamMessage
  (chat.ask, Idempotency-Key, Accept: text/event-stream)
           │
           ▼
  Knowledge gate (assertKnowledgeReadable)
           │
     ┌─────┼──────────────┐
     ▼     ▼              ▼
   deny   queue          allow
     │     │              │
     │     ▼              ▼
     │   202 JSON       Insert user + pending assistant messages
     │   (chatQueue)      Open SSE → status: accepted
     │                    invokeChatGraph(...)
     │                         │
     │                         ▼
     │                    LangGraph (this process)
     │                         │
     │              ┌──────────┼──────────┐
     │              ▼          ▼          ▼
     │         interrupt   done/abstain  error/abort
     │         (clarify)   SSE done      interrupted / error
     └─────────────┴──────────┴──────────┘
```

Edit / retry reuse the same `runChatStreamForExistingUser` path after rewriting
messages (`editMessage` / `retryMessage`).

Disconnect / Stop → `AbortSignal` → assistant marked `interrupted` (ADR 0037).

---

## 4. Full graph: nodes and edges

Compiled in `compileChatGraph` (`chatGraph.js`).

```text
                         START
                           │
                           ▼
                     load_context
                           │
                           ▼
                      understand
                           │
           ┌───────────────┼───────────────┬────────────────┐
           │ routeAfterUnderstand          │                │
           ▼               ▼               ▼                ▼
      clarify_set    abstain_early    agent_tools     reply_direct
           │               │               │                │
           ▼               │         (tool loop)            ▼
      clarify_wait         │               │         persist_direct_reply
           │               │    ┌──────────┼──────────┐            │
     ┌─────┴─────┐         │    ▼          ▼          ▼            ▼
     ▼           ▼         │ clarify_set  draft   persist_        END
 understand  abstain_early │ (ADR 0040)  _answer   abstain
 (again)         │         │    │          │          │
                 │         │    │          ▼          │
                 │         │    │   verify_answer     │
                 │         │    │          │          │
                 │         │    │  ┌───────┼──────────┤
                 │         │    │  ▼       ▼          ▼
                 │         │    │ persist agent_tools persist_abstain
                 │         │    │  _done   (revise≤1)
                 └────┬────┴────┴────┴───────┴──────────┘
                      │
                      ▼
                     END

  agent_tools also loops to itself until finish / budget / abstain tool.
  ask_clarification (when gated) → clarify_set → clarify_wait → understand.
```

### Fixed edges (always)

| From | To |
| ---- | -- |
| `START` | `load_context` |
| `load_context` | `understand` |
| `clarify_set` | `clarify_wait` |
| `abstain_early` | `persist_abstain` |
| `draft_answer` | `verify_answer` |
| `reply_direct` | `persist_direct_reply` |
| `persist_done` / `persist_abstain` / `persist_direct_reply` | `END` |

### Conditional edges (choice functions)

| After node | Function | Possible next nodes |
| ---------- | -------- | ------------------- |
| `understand` | `routeAfterUnderstand` | `clarify_set`, `abstain_early`, `agent_tools` (label `retrieve`), `reply_direct` |
| `clarify_wait` | `routeAfterClarifyWait` | `understand`, `abstain_early` |
| `agent_tools` | `routeAfterAgentTools` | `clarify_set`, `agent_tools`, `draft_answer`, `persist_abstain`, `reply_direct` |
| `verify_answer` | `routeAfterVerify` | `persist_done`, `agent_tools`, `persist_abstain` |

---

## 5. What each node does

| Graph node | Runner | Job | Observable stage (SSE `status.stage`) |
| ---------- | ------ | --- | ------------------------------------- |
| `load_context` | `runLoadContextNode` | Load recent turns / summary from Mongo (`conversationContext.js`) | — |
| `understand` | `runUnderstandNode` | LLM structured JSON: rewrite question, clarify?, route | `understanding_question` |
| `clarify_set` | `runClarifySetNode` | Build clarify payload | `awaiting_clarification` (then interrupt) |
| `clarify_wait` | `runClarifyWaitNode` | `interrupt(...)` until resume with answers | — (HTTP emits `clarification` event) |
| `abstain_early` | `runAbstainEarlyNode` | Mark early abstain before tools | `abstain_early` |
| `agent_tools` | `runAgentToolsNode` | Budget → tool-choice LLM → `executeTool`, finish, or `ask_clarification` (ADR 0040) | `searching_code` / `reviewing_sources` (clarify → `awaiting_clarification`) |
| `draft_answer` | `runDraftAnswerNode` | Stream grounded draft from evidence | `generating_answer` (+ SSE `delta`) |
| `verify_answer` | `runVerifyAnswerNode` | Deterministic then optional LLM verify | `verifying_answer` |
| `reply_direct` | `runDirectReplyNode` | Converse / general / overview fallback (no VERIFY) | `composing_reply` |
| `persist_done` | `runPersistDoneNode` | Save completed answer + evidence | → SSE `evidence`, `done` |
| `persist_abstain` | `runPersistAbstainNode` | Save abstain / failed | → SSE `done` |
| `persist_direct_reply` | `runPersistDirectReplyNode` | Save direct reply (`supportLevel` null) | → SSE `done` |

---

## 6. Case flows (follow one path)

### Case A — Project question with evidence (happy path)

Typical: “Where is auth validated?” → `route: retrieve`.

```text
load_context → understand → agent_tools ⇄ (call tools) → draft_answer
  → verify_answer (pass|partial) → persist_done → END
```

**SSE sketch:** `status(accepted)` → `understanding_question` → `searching_code` /
`reviewing_sources` → `generating_answer` + `delta*` → `verifying_answer` →
`evidence` → `done`.

---

### Case B — Greeting / identity (`converse`) or off-topic (`general_knowledge`)

UNDERSTAND sets `route` to `converse` or `general_knowledge` (ADR 0039).

```text
load_context → understand → reply_direct → persist_direct_reply → END
```

No tools, no VERIFY. Stage: `composing_reply`. Persists `completed` with
`supportLevel: null`. General answers prepend a fixed Markdown note.

---

### Case C — Need clarification

UNDERSTAND sets `needsClarification: true` (and rounds remain under
`CLARIFICATION_MAX_ROUNDS` = 2).

```text
load_context → understand → clarify_set → clarify_wait
       │                                      │
       │                              interrupt → SSE clarification
       │                                      │
       │         POST /conversation/clarification/answer
       │         resumeChatGraphFromClarification (Command resume)
       │                                      │
       └────────────── understand ◄───────────┘
                       (then Case A / B / D / …)
```

If rounds are exhausted (`clarifyRoundCount >= 2`), `routeAfterUnderstand` forces
`abstain_early` instead of another clarify set.

Wrong `clarificationSetId` on resume → wait node forces `abstain_early`.

---

### Case D — Early abstain (cannot proceed)

UNDERSTAND `route: abstain_early`, or clarify rounds exhausted, or invalid UNDERSTAND
JSON after repair (falls back to abstain).

```text
load_context → understand → abstain_early → persist_abstain → END
```

---

### Case E — Retrieve / overview, but tools find nothing

```text
… → agent_tools (finish / budget / abstain tool) → routeAfterAgentTools
         │
         ├─ has evidence? → draft_answer → …
         ├─ route === project_overview? → reply_direct (description fallback)
         └─ else → persist_abstain
```

---

### Case F — VERIFY revise once

VERIFY may set `result: 'revise'` at most `MAX_VERIFY_REVISE` (1) time
(`finishVerifyState` in `chatGraph.helper.js`).

```text
draft_answer → verify_answer → agent_tools (again) → draft_answer → verify_answer
                    │                                         │
                    └─ pass/partial → persist_done            └─ still fail → persist_abstain
```

---

### Case G — Knowledge updating / unavailable (before the graph)

Handled in `chatStream.js` / gate — **not** a LangGraph node:

| Gate | Result |
| ---- | ------ |
| deny | HTTP error (`KNOWLEDGE_UNAVAILABLE`, …) |
| queue | `202` + queued message (`chatQueue.js`); worker drains later |
| allow | SSE + graph |

---

## 7. UNDERSTAND routing (edge choice detail)

LLM returns validated JSON (`understandDecisionSchema`):

| Field | Role |
| ----- | ---- |
| `rewrittenQuestion` | Cleaner question for tools / draft (fallback: original) |
| `needsClarification` | If true → clarify path (unless max rounds) |
| `clarificationQuestions[]` | UI questions for the set |
| `route` | See table below |

`routeAfterUnderstand` (code order matters):

```text
  needsClarification?
    yes + rounds exhausted → abstain_early
    yes + rounds left      → clarify_set
  route === abstain_early  → abstain_early
  route === converse
    OR general_knowledge   → reply_direct
  else (retrieve OR
    project_overview)      → agent_tools   // edge map key: "retrieve"
```

| `route` value | Intent |
| ------------- | ------ |
| `retrieve` | Need project evidence via tools |
| `project_overview` | Try tools first; if empty → description fallback (`reply_direct`) |
| `converse` | Greeting / product identity — no retrieval |
| `general_knowledge` | Off-topic — no retrieval |
| `abstain_early` | Cannot proceed |

---

## 8. Tool selection (`agent_tools`)

One visit to `agent_tools` = **one** tool-choice decision (optional one tool call).
The conditional edge may send you **back** to `agent_tools` for another iteration.

### Inside the node

```text
  abort? → retrievalComplete
  assertRunBudget → fail? budgetExhausted
  requestToolChoiceDecision (LLM JSON)
       │
       ├─ invalid → repair once → still invalid?
       │     has evidence? finish : deterministic explore_code once → finish
       │
       ├─ action: finish_retrieval → retrievalComplete
       │
       └─ action: call_tool
             executeTool(name, args)  → append evidence to toolResults
             toolStop (e.g. abstain tool)? → retrievalComplete
```

Tool-choice JSON (`toolChoiceDecisionSchema`):

```json
{
  "action": "call_tool" | "finish_retrieval",
  "toolName": "explore_code" | "search_documents" | "list_documents"
            | "read_document_slice" | "read_file_slice" | "abstain",
  "toolArgs": { },
  "reason": "short optional product text — never chain-of-thought"
}
```

### Allowed tools (`agentTools.js`)

| Tool | What it reads | SSE stage |
| ---- | ------------- | --------- |
| `explore_code` | CodeGraph symbols / paths / snippets | `searching_code` |
| `search_documents` | Mongo FTS on doc sections | `reviewing_sources` |
| `list_documents` | Doc path metadata | `reviewing_sources` |
| `read_document_slice` | Doc heading / line range | `reviewing_sources` |
| `read_file_slice` | Code/config line range | `reviewing_sources` |
| `abstain` | Stop retrieval (`toolStop`) | (no stage) |

Tools never call the LLM to invent code. The model only **chooses** the tool; execution
is deterministic under org + project + knowledge version scope.

### After the node (`routeAfterAgentTools`)

```text
  needsClarification? (ask_clarification passed gates — ADR 0040)
       → clarify_set
  still looping? (not budgetExhausted / toolStop / retrievalComplete)
       → agent_tools again
  has toolResults?
       → draft_answer
  route === project_overview?
       → reply_direct
  else
       → persist_abstain
```

Tool-choice actions: `call_tool` | `finish_retrieval` | `ask_clarification`.
`ask_clarification` is offered only when evidence count is 0 or ≥ 2 and shared clarify
rounds remain; otherwise it is treated as `finish_retrieval`.

There is **no fixed max tool rounds**. The run stops when the model finishes retrieval,
calls `abstain`, asks clarification, hits run budgets (`runBudget.js` / `LLM_RUN_MAX_*`),
or aborts.

---

## 9. VERIFY outcomes (`routeAfterVerify`)

| `verifyResult.result` | Next node |
| --------------------- | --------- |
| `pass` or `partial` | `persist_done` |
| `revise` | `agent_tools` (at most once) |
| anything else (e.g. `abstain`) | `persist_abstain` |

Deterministic checks run first (citations, paths, knowledge version). LLM verify only
if the draft is still `ambiguous` and budget allows.

---

## 10. SSE events (what the UI sees)

Emitted by `chatStream.js` from graph hooks:

| Event | When |
| ----- | ---- |
| `status` | Stage changes (`accepted`, `understanding_question`, `searching_code`, …) |
| `delta` | Answer token chunks (draft / direct reply) |
| `clarification` | Interrupt payload (questions for the UI) |
| `evidence` | Cited evidence items before `done` |
| `done` | Terminal success / abstain persist |
| `error` | Mid-stream failure |

Frontend parser: `frontend/src/features/chat/api/chatStreamApi.js`.

---

## 11. Mental model: who decides what?

```text
  UNDERSTAND LLM     → clarify? which high-level route?
  Tool-choice LLM    → which scoped tool next, or finish retrieval?
  executeTool        → real evidence from CodeGraph / Mongo / files
  DRAFT LLM          → answer text citing evidence ids
  VERIFY (code+LLM)  → pass / partial / revise / abstain
  Direct-reply LLM   → greetings / general / description fallback only
  HTTP (chatStream)  → SSE, persistence status, abort, clarify resume
```

---

## 12. Related reading

| Doc | Why |
| --- | --- |
| [`architecture.md`](./architecture.md) §6 | Product-level chat topology |
| [`adr/0035-langgraph-mongo-checkpointer.md`](./adr/0035-langgraph-mongo-checkpointer.md) | Why Mongo checkpoints |
| [`adr/0037-chat-sse-abort-on-disconnect.md`](./adr/0037-chat-sse-abort-on-disconnect.md) | Stop / disconnect |
| [`adr/0039-conversational-and-general-replies.md`](./adr/0039-conversational-and-general-replies.md) | Direct-reply routes |
| `docs/plan/phase-47` … `phase-52` | Historical implementation plans |

**Tests to read as executable examples:**

- `backend/tests/modules/conversation/chatGraph.test.js`
- `backend/tests/modules/conversation/chatGraph.integration.test.js`
- `backend/tests/modules/conversation/chatStream.routes.test.js`
