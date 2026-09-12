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
context, run **UNDERSTAND** with thinking **disabled**, parse a structured routing decision, optionally
enter **CLARIFY_SET** (interrupt + Mongo checkpoint), or route toward retrieval / early abstain. The
graph exposes **hooks** for observable stages (`understanding_question`, etc.) that phase 50 wires to
SSE — this phase does not open HTTP streams. Checkpoints persist in Mongo so clarification resume and
client disconnect recovery have a durable thread id. You can see it working in integration tests:
invoke the graph with a fixture question → state contains `rewrittenQuestion` and `route`; a
`needsClarification: true` fixture interrupts with a full clarification set shape ready for phase 52.

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
- Graph module: initial state type, node functions, conditional edges from UNDERSTAND (solution §5.2
  diagram).
- **UNDERSTAND** node: build messages from phase 44 context; phase 43 budget preflight; call phase 45
  `generateText` with **thinking disabled**; validate structured JSON (Zod or equivalent).
- Structured output fields (solution §5.2 node A): `rewrittenQuestion`, `needsClarification`,
  `clarificationQuestions[]` (typed: single_select | multi_select | free_text), `route`
  (`retrieve` | `clarify` | `abstain_early` — exact enum PROPOSED below).
- **CLARIFY_SET** node: persist clarification set on run state / message placeholder; **graph
  interrupt** with checkpoint; define interrupt resume input shape (answers map) — **no** HTTP route.
- **ABSTAIN_EARLY** node: terminal insufficient-info path before tools (routes to persist stub or
  end state consumed by 49).
- Mongo **checkpointer** adapter (collection name PROPOSED in §6) scoped by `orgId`, `conversationId`,
  `runId` / `threadId`.
- Stage hook interface: `onStage({ stage, data })` — phase 50 subscribes to emit SSE `status`.
- Record context metrics from phase 44 on UNDERSTAND (measured tokens, compaction actions — no
  fabricated numbers).

### Out of scope (owner phase)

- AGENT_TOOLS loop and run budgets — **phase 48**.
- DRAFT, VERIFY, PERSIST — **phase 49**.
- `POST .../messages` SSE, knowledge gate, idempotency — **phase 50**.
- Clarification HTTP `POST .../answers` — **phase 52**.
- Tool registry implementations — **phase 46** (graph may reference route only).

## 4. Design

### 4.1 Process placement

Per architecture §2 and §6.1, LangGraph runs **in the API process** on the chat request path — not
in the worker. This phase builds `compileChatGraph({ checkpointer, hooks })` callable from phase 50's
service. Heavy ingest remains on the worker; only model inference and in-process graph/CodeGraph run
here.

### 4.2 Graph topology (this phase)

```text
START → load_context (optional node or service pre-step)
     → UNDERSTAND
            ├─ needsClarification → CLARIFY_SET → INTERRUPT (checkpoint)
            ├─ route retrieve     → END (hand off to phase 48 entry: AGENT_TOOLS)
            └─ abstain_early      → ABSTAIN_EARLY → END (hand off to 49 persist)
```

Phase 48 **extends** the compiled graph by adding AGENT_TOOLS and edges from the `retrieve` exit — or
merges into one graph file with placeholder nodes throwing `NOT_IMPLEMENTED` until 48 lands. Prefer
one `chatGraph.js` with staged node registration to avoid two compilers.

### 4.3 UNDERSTAND node

**Prompt intent (backend §51):** rewrite the user question using conversation context; decide if
clarification is needed; **do not answer the project question yet** (solution §5.2, architecture
§6.2).

**LLM call:** phase 45 queue → `generateText` with structured output schema. **Thinking disabled**
for this node (product rule — no private chain-of-thought in UNDERSTAND output or logs).

**On success:**

- Write `rewrittenQuestion`, `clarificationQuestions`, `route` into graph state.
- Invoke hook: `{ stage: 'understanding_question' }` (maps to SSE in 50).
- Append measured token usage to state counters for phase 48 budgets.

**On validation failure:** retry once with repair prompt; still invalid → structured error or
`abstain_early` — do not silently default route (no-assumptions).

### 4.4 CLARIFY_SET interrupt shape

When `needsClarification: true`:

1. Normalise questions to stable ids (`q1`, `q2`, …).
2. Build **clarification set** object (persisted in phase 52 collection; here written to state +
   optional draft fields on pending assistant message if phase 41 defines them):

```text
ClarificationSet (interrupt value)
├── clarificationSetId
├── questions[]: { id, type, prompt, options? }
├── issuedAt
└── roundIndex              0 = first set; max one follow-up set (solution §5.6)
```

3. Call LangGraph `interrupt(clarificationSet)`; checkpoint to Mongo.
4. Hook: `{ stage: 'awaiting_clarification' }` — **not** the SSE `clarification` event payload;
   phase 50 sends full list in `clarification` event when wiring.

**Resume input (internal, from phase 52 service later):**

```text
{ clarificationSetId, answers: Record<questionId, string | string[]> }
```

Graph resumes → merge answers into state → re-enter UNDERSTAND or proceed to `retrieve` per policy
(solution §5.4: resume at UNDERSTAND or AGENT_TOOLS — **open question** §12).

### 4.5 Checkpointer

Use LangGraph's MongoDB checkpointer pattern or a thin custom saver:

- Keys: `thread_id` = `{orgId}:{conversationId}:{assistantMessageId}` (PROPOSED — confirm with 50
  idempotency story).
- Store: channel values + interrupt metadata; **no** raw LLM chain-of-thought fields.
- TTL / cleanup: defer to phase 60 retention unless orphaned checkpoints need a constant sweeper
  (ask).

### 4.6 Initial graph state (extends solution §5.1 step 3)

```text
ChatGraphState
├── scope: orgId, projectId, userId, conversationId, userMessageId, knowledgeVersionId, correlationId
├── question, rewrittenQuestion
├── clarificationSet, clarificationAnswers
├── route, toolResults (empty until 48)
├── contextSummary, pinnedFacts, recentMessages (handles from 44)
├── metrics: contextLimit, measuredInput, reservedOutput, compactionActions
├── cumulativeInputTokens, cumulativeOutputTokens, cumulativeToolResultBytes, startedAt
└── draftAnswer, verifyResult (null until 49)
```

## 5. Data model changes

**PROPOSED — needs approval:**

- **`chatCheckpoints`** (or name aligned with LangGraph saver): `orgId`, `threadId`, `checkpointNs`,
  `checkpoint`, `metadata`, `status: 'A'|'D'`, timestamps. Indexes:
  `{ orgId, threadId, createdAt }` for resume lookup.

Clarification persistence may live on **`clarifications`** collection (phase 52); this phase may only
write interrupt payload into checkpoint until 52 defines the canonical store — **open question**.

No change to `Message` required if clarification is checkpoint-only until persist in 52/49.

## 6. API contract — PROPOSED (needs approval before implementation)

**No public HTTP in this phase.** Internal surfaces:

```json
{
  "compileChatGraph": "(deps) => CompiledGraph",
  "invokeUnderstand": {
    "input": "ChatGraphState partial + runContext from phase 50",
    "output": "state | Interrupt<ClarificationSet>"
  },
  "resumeFromClarification": {
    "threadId": "string",
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

Allowed `stage` strings for hooks in this phase: `understanding_question`, `awaiting_clarification`,
`abstain_early` (observable only — backend §66, §67).

## 7. Configuration & environment variables

**None** for graph topology. Ollama URL and model id remain phase 45 env. Checkpoint batch size or
saver poll interval, if needed, are named constants — create only when code reads them.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/package.json` | Add `@langchain/langgraph`, `@langchain/core` at implementation (latest stable) |
| `backend/src/modules/chat/graph/chatGraph.js` (+ `.test.js`) | Graph build, compile, export |
| `backend/src/modules/chat/graph/chatGraph.state.js` | State schema / initialiser |
| `backend/src/modules/chat/graph/nodes/understandNode.js` (+ `.test.js`) | UNDERSTAND + structured parse |
| `backend/src/modules/chat/graph/nodes/clarifySetNode.js` (+ `.test.js`) | Interrupt + set shape |
| `backend/src/modules/chat/graph/nodes/abstainEarlyNode.js` (+ `.test.js`) | Early exit state |
| `backend/src/modules/chat/graph/nodes/loadContextNode.js` (+ `.test.js`) | Bind phase 44 context |
| `backend/src/modules/chat/graph/checkpoint/mongoCheckpointer.js` (+ `.test.js`) | Mongo saver |
| `backend/src/modules/chat/graph/routing.js` (+ `.test.js`) | Conditional edges from UNDERSTAND |
| `backend/src/modules/chat/graph/stageHooks.js` | Hook registry for SSE bridge (50) |
| `backend/src/modules/chat/index.js` | Public exports: `compileChatGraph`, types |

## 9. Tests (≥ 80% line and branch)

### Unit

- UNDERSTAND schema rejects missing fields, extra keys policy, invalid `route`.
- Thinking-disabled flag passed to LLM client mock on every UNDERSTAND call.
- Route `retrieve` does not set clarification set; `needsClarification` always enters CLARIFY_SET.
- Hook invoked once per stage transition; hook throw does not corrupt checkpoint.
- Budget preflight failure surfaces `CONTEXT_ACCOUNTING_UNAVAILABLE` without LLM call.

### Integration

- Graph invoke → checkpoint row exists with `threadId` scoped to org.
- Interrupt → resume with answers → state contains `clarificationAnswers` map.
- Wrong-org resume attempt fails closed (no checkpoint leak).

### Unhappy paths

- LLM timeout → classified temporary error on state for 50 to map to SSE `error`.
- Malformed JSON twice → abstain_early or failed run — document chosen behaviour in tests.

## 10. Definition of Done

- [ ] `@langchain/langgraph` installed per dependency-versions rule; versions in lockfile only.
- [ ] UNDERSTAND runs with thinking disabled and validated structured JSON.
- [ ] CLARIFY_SET interrupt shape documented and covered by tests; no HTTP clarification route.
- [ ] Mongo checkpointer persists and resumes interrupt state.
- [ ] Stage hooks exist; no SSE writes inside graph nodes (50 owns stream).
- [ ] No AGENT_TOOLS, DRAFT, or VERIFY nodes implemented (48/49).
- [ ] No private chain-of-thought stored or logged (§67).
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- Record LangGraph + Mongo checkpointer choice in **`docs/adr/`** if not already covered by phase 4
  stack ADRs (new ADR if checkpoint storage is a new decision).
- `docs/architecture.md` §6.2: align node names with `chatGraph.js`.
- `backend/solution.md` §5.2 node A/B unchanged unless this doc proposes a schema fix.

## 12. Risks & open questions

1. **Resume target after clarification:** UNDERSTAND again vs straight to AGENT_TOOLS (solution §5.4
   step 6) — confirm before phase 52 implements resume.
2. **thread_id composition:** tie to `assistantMessageId` vs separate `runId` for idempotent retries
   (phase 12 + 50).
3. **Checkpointer collection** vs reusing LangGraph official MongoDB package API — install-time choice.
4. **Follow-up clarification set:** enforce max one extra set in graph or in 52 only?
5. **Phase 05:** model id and context sizes affect UNDERSTAND prompt size — blocked on evaluation for
   production limits, not for graph shape.
