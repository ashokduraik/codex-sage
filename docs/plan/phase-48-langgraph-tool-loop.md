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
model stops requesting tools or a **run budget** trips. There is **no fixed maximum tool-round count**.
Run-budget and host numbers come from **`npm run measure-llm-host`** and live in `backend/.env`
(`LLM_RUN_MAX_*`, `LLM_CONTEXT_CAPACITY`, `LLM_QUEUE_MAX_CONCURRENCY`).

## 2–11

See implementation in:

- `backend/src/modules/conversation/chatGraph.js` — AGENT_TOOLS loop
- `backend/src/modules/conversation/runBudget.js` — enforcer reading `loadConfig().llm.runBudget`
- `scripts/measure-llm-host.mjs` — single measurement script (context + queue + run budgets)
- `docs/evaluation/README.md` — runbook

## Locked decisions

1. One measure script: `npm run measure-llm-host` (prints recommended `.env` values to console).
2. Promote by editing `backend/.env` and `backend/.env.example` (re-run when model/host changes).
3. Tool-choice thinking disabled; `maxTotalCalls` = tool-choice LLM + `executeTool`.
4. Budget trip → `budgetExhausted: true`; phase 49 chooses draft vs abstain.
5. No `MAX_TOOL_ROUNDS`; no new Mongo schema.
