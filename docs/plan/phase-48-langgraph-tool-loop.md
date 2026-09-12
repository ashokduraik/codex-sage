# Phase 48 — LangGraph workflow: tool loop & run budgets

- **Layer:** BE
- **Depends on:** Phase 46 (agent tools), Phase 47 (graph shell, UNDERSTAND, checkpoints, hooks)
- **Unblocks:** Phase 49
- **Size:** 1–2 days
- **Requirements covered:** backend §57, §66, §70; backend/solution.md §5.2 node C, §5.6;
  docs/architecture.md §6.2 (AGENT_TOOLS, no fixed rounds), §7 (read lease during chat)

## 1. Goal

After this phase the compiled chat graph includes **AGENT_TOOLS**: the model chooses among the six
scoped tools (phase 46), Node executes them, appends budgeted evidence to state, and loops until the
model stops requesting tools or a **run budget** trips. There is **no fixed maximum tool-round count**
(architecture §6.2, backend §70). Observable stages `searching_code` and `reviewing_sources` fire
through phase 47 hooks — not private reasoning text (backend §67). Budget **policy and enforcement
machinery** ship here; numeric limits remain **open** until phase 05 evaluation (README cross-cutting
#9). You can see it working in tests: mock LLM returns two tool calls → two evidence batches in state;
exhausting a mocked token budget ends the loop with a structured outcome for phase 49.

## 2. Why this phase is here

UNDERSTAND (47) decides *whether* to retrieve; this phase performs *bounded retrieval*. Splitting tools
(46) from the loop keeps CodeGraph/Mongo out of graph node files and keeps budget logic testable.
Phase 49 needs `toolResults[]` populated before DRAFT — so 48 must complete first. It cannot merge
with 46: tools are reusable and budgeted independently of LangGraph routing.

## 3. Scope

### In scope

- **AGENT_TOOLS** node(s): tool-choice LLM call via phase 45 (thinking policy: **disabled for tool
  choice** unless phase 05 says otherwise — default disabled to match UNDERSTAND).
- Wire phase 46 `executeTool` for each model-selected call; append `evidenceRecords` to
  `state.toolResults`.
- Conditional loop: model returns `finish_retrieval` or no tool call → exit to DRAFT entry (phase 49
  node stub or edge to `DRAFT_ANSWER`).
- **Run budget enforcer** `assertRunBudget(state)` before each LLM call and each tool execution:
  cumulative input tokens, cumulative output tokens, cumulative tool-result bytes, total model+tool
  **call count**, wall time since `startedAt` (solution §5.6, backend §70).
- Budget **configuration object** loaded from named constants module — constants **values** are not
  invented here; use `null`/feature flag or test-only mocks until phase 05 (§12).
- On budget exhaustion: structured terminal outcome on state (`budgetExhausted: true`, `outcome`:
  `partial | clarify | abstain | error`) for 49 to persist — exact enum PROPOSED in §6.
- Stage hooks: `searching_code`, `reviewing_sources` (architecture §6.2, backend §66) mapped from
  tool name (`explore_code` → searching_code; document tools → reviewing_sources).
- Increment counters from phase 45 usage fields when present; never fabricate token counts (backend
  §68).
- Honour `abortSignal` from run context: stop loop, release leases, leave recoverable state for 50.

### Out of scope (owner phase)

- DRAFT_ANSWER, VERIFY_ANSWER, PERSIST — **phase 49**.
- SSE HTTP framing — **phase 50** (hooks only here).
- New tools beyond the six — **phase 46** only.
- In-app rate limiting — README §4 / architecture §10 (none).

## 4. Design

### 4.1 Extended graph

```text
… UNDERSTAND → (retrieve) → AGENT_TOOLS ⟲
                                  │
                                  ├─ budget ok + tool call → executeTool → AGENT_TOOLS
                                  ├─ budget exhausted → BUDGET_STOP → END (→ 49)
                                  └─ finish / abstain tool → END (→ DRAFT or ABSTAIN)
```

`abstain` tool from phase 46 short-circuits to abstain path without DRAFT when appropriate.

### 4.2 Tool-choice prompt

Node builds messages:

- System: choose one tool or signal retrieval complete; only listed tools; must respect scope.
- Include `rewrittenQuestion`, compact `toolResults` summary (ids + paths, not full excerpts).
- Phase 43 budget preflight on the **exact** messages array before `generateText`.

Model output schema PROPOSED:

```json
{
  "action": "call_tool | finish_retrieval",
  "toolName": "optional when call_tool",
  "toolArgs": "object",
  "reason": "optional short string — not chain-of-thought; omit from SSE"
}
```

### 4.3 Run budget enforcer

Module `backend/src/modules/chat/runBudget.js`:

```text
RunBudgetConfig (values from phase 05 — OPEN)
├── maxCumulativeInputTokens?
├── maxCumulativeOutputTokens?
├── maxCumulativeToolResultBytes?
├── maxTotalCalls?              model + tool executions counted
└── maxWallTimeMs?

RunBudgetState (on graph state)
├── cumulativeInputTokens
├── cumulativeOutputTokens
├── cumulativeToolResultBytes
├── totalCalls
└── startedAt
```

`assertRunBudget(state, config)`:

- If any configured limit is exceeded → throw `RunBudgetExceededError` with `outcome` hint.
- If config values are **unset** (pre-05): enforcer no-ops those dimensions in production **only if**
  product accepts — **default: block go-live until 05 fills config** (§12 question).

**No fixed tool-round cap** — do not add `MAX_TOOL_ROUNDS` (explicit user rule).

### 4.4 Tool execution path

```text
AGENT_TOOLS node
  → assertRunBudget
  → LLM tool choice (phase 45 queue)
  → if call_tool:
       hook searching_code | reviewing_sources
       assertRunBudget
       executeTool (46) → merge evidence, update byte/token counters
       → loop
  → if finish_retrieval → exit
```

Duplicate tool calls with identical args: allowed but counted toward budgets; optional dedupe is **out
of scope** unless requirements demand — ask.

### 4.5 Interaction with knowledge gate

If graph health flips mid-loop (unlikely on single request): tool throws `KNOWLEDGE_UNAVAILABLE` → loop
ends with retryable error state for 50. Queued questions during index updates are **phase 51** — not
handled inside the loop.

## 5. Data model changes

**None** beyond phase 47 checkpoints. `toolResults` live in graph state until phase 49 persists
evidence on `Message`.

## 6. API contract — PROPOSED (needs approval before implementation)

**Internal only.**

```json
{
  "extendChatGraphWithToolLoop": "(compiledGraph from 47) => CompiledGraph with AGENT_TOOLS",
  "runBudgetExceeded": {
    "code": "RUN_BUDGET_EXCEEDED",
    "outcome": "partial | clarify | abstain | error",
    "retryability": "permanent | temporary per catalog"
  },
  "toolChoiceSchema": "see §4.2"
}
```

SSE mapping (implemented in 50, documented here for alignment):

| Hook stage | SSE event | `data` (minimal) |
|------------|-----------|------------------|
| `searching_code` | `status` | `{ stage: 'searching_code' }` |
| `reviewing_sources` | `status` | `{ stage: 'reviewing_sources' }` |

No `delta` events in this phase.

## 7. Configuration & environment variables

**None.** All budget numbers are **named constants** in `runBudget.constants.js` (or adjacent file)
filled after phase 05. Until then:

- Tests use explicit small caps in fixtures.
- Production deployment **must not** guess defaults (open question §12).

Wall-clock uses `Date.now()` vs monotonic clock — prefer monotonic for deadline if available in Node
without new deps.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/chat/graph/nodes/agentToolsNode.js` (+ `.test.js`) | Loop body |
| `backend/src/modules/chat/graph/nodes/budgetStopNode.js` (+ `.test.js`) | Budget terminal |
| `backend/src/modules/chat/runBudget.js` (+ `.test.js`) | Enforcer + state updates |
| `backend/src/modules/chat/runBudget.constants.js` | Placeholder exports for 05-derived values |
| `backend/src/modules/chat/graph/chatGraph.js` | Wire AGENT_TOOLS edges into compile |
| `backend/src/modules/chat/graph/routing.js` | Loop vs exit conditions |
| `backend/src/modules/chat/tools/index.js` | **Consume** executeTool |
| `backend/src/platform/errorCatalog.js` | Register `RUN_BUDGET_EXCEEDED` if new code needed |

## 9. Tests (≥ 80% line and branch)

### Unit

- Loop exits on `finish_retrieval` without tool execution.
- Each tool name invokes correct 46 executor mock.
- Budget enforcer trips on each dimension independently (mock config with low limits).
- No `MAX_TOOL_ROUNDS` constant exists in codebase (grep assertion in test).
- Hooks fire per tool category; hook failure does not skip lease release (via 46).
- AbortSignal aborts between iterations; state reflects partial `toolResults`.

### Integration

- Graph invoke from UNDERSTAND `retrieve` through two tool iterations → state evidence count.
- Checkpoint mid-loop → resume continues budget counters from persisted state.

### Unhappy paths

- Unknown tool name from model → permanent error, no tool execution.
- `KNOWLEDGE_UNAVAILABLE` from explore_code → loop terminates with knowledge error class.
- Config all null → document expected behaviour (fail closed vs no-op).

## 10. Definition of Done

- [ ] AGENT_TOOLS node integrated into compiled graph after UNDERSTAND retrieve path.
- [ ] All six tools reachable; no extra tools.
- [ ] Run budget enforcer runs before each LLM and tool call; **no fixed round cap**.
- [ ] Budget numeric values not invented for production — §12 acknowledged in code comments/constants.
- [ ] Stage hooks for `searching_code` and `reviewing_sources`; no CoT in hook payloads.
- [ ] DRAFT/VERIFY not implemented; edges point to 49 stubs or END.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `backend/solution.md` §5.6 run bounds table: reference `runBudget.constants.js` as single source
  once phase 05 fills values.
- `docs/architecture.md` §6.2: confirm "no fixed max tool rounds" in implementation.

## 12. Risks & open questions

1. **Phase 05 budget numbers** — all of `maxCumulativeInputTokens`, output, tool bytes, call count,
   wall time: **open**; go-live blocked until evaluation locks them?
2. **Pre-05 behaviour:** should missing config disable enforcement entirely or use conservative
   hardcoded **test-only** caps in non-production?
3. **Tool-choice thinking:** confirm disabled like UNDERSTAND.
4. **Budget exhaustion outcome:** default abstain vs partial grounded answer — product choice for 49.
5. **Counting tool calls vs model calls** toward `maxTotalCalls` — confirm inclusion rules with
   backend §70 wording.
