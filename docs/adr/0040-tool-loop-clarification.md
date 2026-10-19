# ADR 0040 — Clarification from the agent tool loop

- Status: Accepted
- Date: 2026-10-19
- Deciders: product owner

## Context

UNDERSTAND can ask clarifying questions before retrieval, but it sees only
conversation history — not project evidence. Ambiguous questions such as "How
does the calculator work?" often look clear until tools return several unrelated
paths (for example EMI calculator and chit-fund calculator). The tool loop could
only choose `call_tool` or `finish_retrieval`, so the draft answered from the
first matching evidence and never asked the user which feature they meant.

## Decision

- Extend AGENT_TOOLS tool-choice with action `ask_clarification`, carrying the
  same `clarificationQuestions[]` shape as UNDERSTAND (`single_select`,
  `multi_select`, `free_text`).
- Route a successful ask through the existing `clarify_set` → `clarify_wait`
  interrupt (Mongo checkpoint, SSE `clarification`, frontend wizard, answer
  resume). No change to `clarificationSets`, chatStream, or the UI contract.
- **Evidence gate:** the model may ask only when gathered evidence has **0**
  records or **≥ 2** records. Exactly one record is treated as
  `finish_retrieval` (draft from that evidence).
- **Shared round budget:** at most two clarification sets per assistant run
  (`roundIndex` 0 then 1), shared with UNDERSTAND. No schema change.
- **Exhausted or unusable ask** (rounds used up, empty questions, empty prompt,
  or select with fewer than two options) → treat as `finish_retrieval` (draft or
  abstain / overview fallback with whatever evidence exists). Do not force
  UNDERSTAND-style early abstain from the tool loop.
- **Resume:** answers bind in `clarify_wait`, graph continues at UNDERSTAND
  (existing path). Prior `toolResults` stay on state (append reducer); the loop
  may retrieve more for the narrowed question, then draft.
- Offer `ask_clarification` in the tool-choice JSON schema and system prompt only
  when the evidence gate and round budget allow it.

## Consequences

- Ambiguous project questions can clarify after real evidence is visible.
- Clarification options can be grounded in retrieved paths rather than guessed
  before retrieval.
- Tool-choice prompts grow slightly when asking is allowed; an ignored ask still
  burns one model call then finishes.
- Branch coverage on `chatGraph.js` remains limited by long-standing error-path
  branches; new ask paths are covered by unit tests.

## Alternatives considered

- Dedicated post-retrieval LLM node — rejected for this change; reuses tool-choice
  and avoids an extra always-on call.
- Pseudo-tool `ask_clarification` in `agentTools.js` — rejected; clarification is
  graph routing, not a scoped knowledge tool.
- Separate after-retrieval round budget / schema bump on `roundIndex` — rejected;
  keep two sets total.
- Heuristic-only clustering of evidence folders — rejected; model judges when to
  ask, with a hard evidence-count gate.

## Escape hatch

Remove `ask_clarification` from tool-choice actions and the
`routeAfterAgentTools` → `clarify_set` edge; clarification returns to
UNDERSTAND-only.
