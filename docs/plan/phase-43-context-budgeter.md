# Phase 43 — Context budgeter & tokenizer parity

- **Layer:** BE + EVAL
- **Depends on:** Phase 02 (error catalog)
- **Unblocks:** Phase 44, 45, 46
- **Size:** 2–3 days (implementation PR after this document)
- **Requirements covered:** `backend/requirments.md` §43 (context management), §44 (context limit
  metrics inputs), §70 (context consumption); `backend/solution.md` §1.2 (budget before every LLM
  call); `docs/architecture.md` §6.2 (every model call measured)

## 1. Goal

After this phase a shared **`contextBudgeter`** in the **conversation** module can take assembled
segments (roles + content + tool blocks), count tokens with a **tokenizer that matches the active
model artifact**, subtract reserved output and system/tool overhead, and either return a sendable
payload or **compact in the documented order**. If counting is unavailable or parity is not proven,
every caller gets **`CONTEXT_ACCOUNTING_UNAVAILABLE`** — no prompt is sent with guessed sizes
(backend §43, solution §1.2, architecture §6.2).

Operators can re-measure context on any host with
`npm run measure-llm-context` ([`scripts/measure-llm-context.mjs`](../../scripts/measure-llm-context.mjs);
runbook: [`docs/evaluation/README.md`](../evaluation/README.md)). This machine’s latest run is
[`docs/evaluation/phase-43-context.md`](../evaluation/phase-43-context.md).

You can see the module working in unit tests: under a fixture tokenizer, assembly fits budget; when
input exceeds budget, compaction steps run in order; when the tokenizer adapter throws, callers fail
closed.

## 2. Why this phase is here

Phases 45 (LLM client), 46 (agent tools), and 48 (run budgets) must not each implement ad-hoc token
math. Requirements §43–§44 and §70 tie **reliable measurement** to whether a model call may start.

Phase 05 locked CodeGraph/preview numbers only and **deferred** tokenizer and context-window lock
here. This phase owns both the reusable OpenAI-compatible measurement **and** the conversation-module budgeter
that consumes those numbers. Phase 41 conversation rows are markdown `user|assistant|system`
messages; the budgeter invents its own segment kinds. Loaders that persist summaries are Phase 44.

## 3. Scope

### In scope

- Reusable measurement script + runbook (already the operator tool; re-run on every environment).
- Conversation resource `backend/src/modules/conversation/contextBudgeter.js` with a single public
  entry: `prepareModelInput({ modelArtifactRef, purpose, segments, options })`.
- Export `prepareModelInput` (and config getters) from `conversation/index.js` so later phases import
  the barrel — no fifth domain module, no `platform/context/`.
- **Segment model:** typed blocks (system rules, user question, summary, turn, tool result, pinned
  fact, tool schema overhead) with stable ids for compaction audit trails. Caller sets `protected`.
- Token counting via `createTokenizerAdapter(config)` — injectable `countTokens` /
  `assertArtifactMatch` for tests. Production adapter is chosen after the tokenizer checklist in
  the evaluation runbook; do not put a fake adapter under `src/`.
- Budget math (numbers from the **reviewed** evaluation run on the target host — not invented, not
  copied from another machine):

```text
validatedContextCapacity   ← latest reviewed phase-43-context.md
  − reservedOutputTokens   ← same run
  − systemAndToolSchemaTokens (measured)
  = maximumInputBudget

measuredInput <= maximumInputBudget → ok
measuredInput >  maximumInputBudget → compact (§4.3)
still over after compaction → CONTEXT_BUDGET_EXCEEDED (Phase 47/49 map to clarify vs abstain)
```

- Compaction order **exactly** solution §1.2 / architecture §6.2 (requirements §43 folds shrink into
  step 3; this phase keeps the five-step solution order):

  1. Preserve system/grounding, current question, clarification answers, pinned facts.
  2. Replace older turns with persisted summary segment (summary text supplied by caller — Phase 44
     persists it).
  3. Drop lower-ranked tool/document excerpts; keep source identifiers where required.
  4. Shrink oversized excerpts at natural boundaries.
  5. If minimum grounded prompt still exceeds budget → `CONTEXT_BUDGET_EXCEEDED` with
     `retryability` and compaction log.

- Fail closed: missing tokenizer, artifact mismatch, or unreviewed/missing eval constants →
  `CONTEXT_ACCOUNTING_UNAVAILABLE` (`errorCatalog.js` already has this code).
- Return object includes: `messages` (for a future `ai` SDK), `measuredInputTokens`,
  `maximumInputBudget`, `reservedOutputTokens`, `validatedContextCapacity`, `compactionActions[]` —
  **only when measured**; omit numeric fields when accounting failed.

### Out of scope (owner phase)

- Persisting summaries / pinned facts — **Phase 44**.
- Calling the LLM host or `ai` SDK from the app — **Phase 45** (the eval script talks to an
  OpenAI-compatible `/v1` host as an operator tool only).
- Tool byte budgets and cumulative run budgets — **Phase 48**.
- LangGraph nodes — **Phases 47–49**.
- HTTP exposure of metrics — **Phase 44** on message payloads.
- Queue concurrency, thinking on/off, TTFT soak — **Phase 45**.
- `applyToolResultBudget` — **not added**. Phase 46 maps tool hits to segments and calls
  `prepareModelInput`.

## 4. Design

### 4.1 Placement

`backend/src/platform/` is infra only (`.cursor/rules/platform-layer.mdc`). Compaction and token
math are conversation domain.

```text
backend/src/modules/conversation/contextBudgeter.js   prepareModelInput + compact + constants
backend/src/modules/conversation/index.js             export public surface
backend/tests/modules/conversation/                   Vitest (mirrors src/)
```

Overflow is `contextBudgeter.helper.js` only after 1000 code lines. Do not add
`contextBudgeter.compact.js` or `fakeTokenizerAdapter.js` up front.

### 4.2 Measurement (repeatable — not a one-time close-out)

Runbook: [`docs/evaluation/README.md`](../evaluation/README.md).

```bash
npm run measure-llm-context -- \
  --base-url "${LLM_BASE_URL:-http://127.0.0.1:11434/v1}" \
  --model qwen3.8:latest
```

Each run overwrites `phase-43-context.md` and `phase-43-context.raw.json` and records host, Node,
model id, and the 32K → 64K → 128K prompt-size ladder. Vendor advertised context is
**not** the operational cap until that window is a passing step on **that** machine.

Re-run when the machine, RAM/GPU, provider, or model id changes; before go-live on a new host;
after an OOM or accounting failure that looks like a wrong cap. Promote the reviewed operational window into `LLM_CONTEXT_CAPACITY` in
`backend/.env` after review. The script never edits application source.

This machine’s latest checked-in run (`Ashoks-MacBook-Pro.local`, 2026-09-26) used the previous
native Ollama protocol (Ollama 0.33.2, digest
`22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643`). Re-run the OpenAI `/v1`
script before treating a new host as measured:

| Constant | This-host value | Purpose |
|---|---|---|
| `validatedContextCapacity` | **131072** (32K, 64K, and 128K passed; advertised 256K was not on the ladder) | Operational window |
| `reservedOutputTokens` | **457** (DRAFT `eval_count` 201 + margin 256) | Subtracted before send |
| `EXCERPT_MIN_TOKENS` | **27** | Shrink floor |
| `COMPACTION_MAX_PASSES` | `8` (loop guard, not eval) | Prevent infinite shrink |

API startup sets artifact id to `LLM_MODEL_ID` after `GET /models` (ADR 0034). Other hosts must
re-run the script; do not copy these three eval numbers without a new note.

### 4.3 Tokenizer adapter

Factory `createTokenizerAdapter(config)` with JSDoc (plain JavaScript, ADR 0000). Tests inject
`countTokens` / `assertArtifactMatch`. If `assertArtifactMatch` fails →
`CONTEXT_ACCOUNTING_UNAVAILABLE` with `details.reason: 'tokenizer_artifact_mismatch'`. Missing
adapter → `details.reason: 'tokenizer_unavailable'`.

Package selection follows the runbook checklist (`dependency-versions.mdc`). GGUF on the current
artifact reports `tokenizer.ggml.model = gpt2` and `pre = qwen35`. Prove parity against fixture
`prompt_eval_count` in `phase-43-context.raw.json`. Do not name a package until that checklist
passes.

### 4.4 Compaction engine

Lives in `contextBudgeter.js` (same file):

- **Protected** segments never removed (caller flags).
- **Turn replacement:** oldest non-protected turn pairs collapse into the supplied
  `summarySegment` (Phase 44 persists).
- **Tool results:** sort by `rank` ascending; drop lowest first; retain `{ sourceId, path }` stubs
  (solution §1.2 step 3).
- **Excerpt shrink:** paragraph-boundary or binary search down to `EXCERPT_MIN_TOKENS`.

Each action appends `{ action: 'drop_turn' | 'replace_with_summary' | 'shrink_excerpt' |
'drop_tool_body', segmentId, beforeTokens, afterTokens }` with **measured** counts only.

### 4.5 Integration points (future)

| Caller | Purpose |
|---|---|
| Phase 45 LLM client (also in `conversation/`, not `platform/llm/`) | Every `generateText` / `streamText` |
| Phase 46 tools | Segments for tool excerpts, then `prepareModelInput` |
| Phase 44 loader | Supply summary + pinned segments |
| Phase 49 VERIFY | Budget optional LLM verify call |

No HTTP handler imports the budgeter in Phase 43.

## 5. Data model changes

**None.** Compaction logs stay in memory; persistence on `Message` is Phase 44.

## 6. API contract — PROPOSED (needs approval before implementation)

**No public HTTP API.** Internal contract:

```json
{
  "prepareModelInputInput": {
    "modelArtifactRef": "qwen3.8:latest",
    "purpose": "understand | draft | verify | summarize | title",
    "segments": [
      { "id": "sys1", "kind": "system", "content": "...", "protected": true },
      { "id": "q1", "kind": "user_question", "content": "...", "protected": true },
      { "id": "turn3", "kind": "turn", "role": "user", "content": "..." }
    ],
    "summarySegment": { "id": "sum", "kind": "summary", "content": "..." },
    "toolSchemaTokenOverhead": 0
  },
  "prepareModelInputOutput": {
    "messages": [{ "role": "user", "content": "..." }],
    "measuredInputTokens": 0,
    "maximumInputBudget": 0,
    "reservedOutputTokens": 0,
    "validatedContextCapacity": 0,
    "compactionActions": []
  },
  "errors": [
    "CONTEXT_ACCOUNTING_UNAVAILABLE",
    "CONTEXT_BUDGET_EXCEEDED"
  ]
}
```

Numeric fields in output are present only when counting succeeded.

`CONTEXT_BUDGET_EXCEEDED` is **new** in `errorCatalog.js` (and frontend `ApiError` + `en.json`).
Recommend `class: 'user'`, `retryability: 'user_action_required'`.
`CONTEXT_ACCOUNTING_UNAVAILABLE` already exists (`class: 'system'`, HTTP 503, `temporary`).

## 7. Configuration & environment variables

Required app env (no defaults). Read only in `platform/config.js`. The measurement
script still takes CLI flags (`--base-url`, `--model`).

| Variable | Example | Purpose |
|---|---|---|
| `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible root; API startup probes `GET /models` |
| `LLM_MODEL_ID` | `qwen3.8:latest` | Exact model id that must exist on that host |
| `LLM_CONTEXT_CAPACITY` | `131072` | Operational window from a reviewed host run |
| `LLM_API_KEY` | (optional) | Bearer token when the host requires it |

Artifact id is **not** a separate env. API startup sets it to `LLM_MODEL_ID` after
`GET /models`. Compaction tunables stay named constants on `contextBudgeter.js`:

| Constant | Value | Purpose |
|---|---|---|
| `RESERVED_OUTPUT_TOKENS` | `457` | Subtracted before send |
| `EXCERPT_MIN_TOKENS` | `27` | Shrink floor |
| `COMPACTION_MAX_PASSES` | `8` | Shrink-loop guard |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `scripts/measure-llm-context.mjs` | Reusable OpenAI-compatible measurement (`npm run measure-llm-context`) |
| `docs/evaluation/README.md` | Runbook for other environments (this pass) |
| `docs/evaluation/phase-43-context.md` | Latest human run (this pass) |
| `docs/evaluation/phase-43-context.raw.json` | Latest machine-readable run (this pass) |
| `.cursor/rules/platform-layer.mdc` | Platform is infra only (this pass) |
| `backend/src/modules/conversation/contextBudgeter.js` | `prepareModelInput` (implementation PR) |
| `backend/src/modules/conversation/index.js` | Export public budgeter surface (implementation PR) |
| `backend/tests/modules/conversation/contextBudgeter.test.js` | Budget + compaction + fail-closed |
| `backend/src/platform/errorCatalog.js` | Add `CONTEXT_BUDGET_EXCEEDED`; confirm accounting code |
| `frontend/src/shared/api/ApiError.js` + `en.json` | Mirror the new code |
| `backend/src/modules/conversation/llm.js` | API startup probe + artifact id = model id |
| ADR 0034 | Required `LLM_*` env, OpenAI-compatible probe, compaction constants |

## 9. Tests (≥ 80% line and branch)

### Unit

- Fake tokenizer + reviewed constants: under budget → no compaction, correct counts.
- Over budget → compaction order matches §4.4 (protected segments untouched).
- Summary replacement uses provided `summarySegment`; oldest turns removed first.
- Tool drop ordering by rank; stubs retain source ids.
- Excerpt shrink reduces tokens monotonically until budget met or floor hit.
- Missing tokenizer / artifact mismatch → `CONTEXT_ACCOUNTING_UNAVAILABLE`, no `messages`.
- Missing or null capacity constants → fail closed (do not invent 32768).

### Integration

- None required for the budgeter. The evaluation script is an operator command, not CI.

### Unhappy paths

- Only protected blocks still over budget → `CONTEXT_BUDGET_EXCEEDED`.
- `COMPACTION_MAX_PASSES` exceeded → budget exceeded, log last actions.

## 10. Definition of Done

### This documentation + measurement pass

- [x] Reusable script + runbook; measurement is not a one-time Phase 05 leftover.
- [x] Latest run written as `phase-43-context.md` / `.raw.json` for this host (128K pass).
- [x] Budgeter planned under `conversation/`, not `platform/`.
- [x] Platform-layer rule added.

### Implementation PR

- [x] Single public `prepareModelInput` used by no HTTP routes yet.
- [x] Compaction order matches solution §1.2 and architecture §6.2.
- [x] Capacity comes from required env; artifact id is the configured model id after `GET /models`; no guessed tokens as measured usage.
- [x] `CONTEXT_ACCOUNTING_UNAVAILABLE` on missing tokenizer/config/parity failure.
- [x] `CONTEXT_BUDGET_EXCEEDED` catalogued (backend + frontend).
- [x] Tests for `contextBudgeter.js` (coverage gate in this change).
- [x] ADR 0034: required `LLM_*` env, artifact id = model id after connect; tokenizer package remains fail-closed until parity.

## 11. Documentation & ADR updates

- This file and `docs/plan/README.md` (D3 + phase 05/43 rows).
- Implementation PR: `docs/architecture.md` §6.2 — split accounting-unavailable vs budget-exceeded;
  link `modules/conversation/contextBudgeter.js`.
- Implementation PR: ADR 0034 — required `LLM_*` env, artifact id = model id after connect.
- `backend/solution.md` §1.2 remains authoritative.

## 12. Risks & open questions

1. **Tokenizer npm package** — none chosen until the runbook checklist and parity fixtures pass.
2. **64K / 128K OOM** — stop at the last passing window; do not invent a larger cap.
3. **Reserved output** — one constant vs per-`purpose`; use the evaluation recommendation unless a
   later run justifies a split.
4. **Tool schema overhead** — measured per call from caller-supplied schema text (Phase 46).
5. **Minimum grounded prompt** — caller `protected` flags; Phase 47 sets them.
6. **Cross-host constants** — never promote another machine’s cap without a new run.
