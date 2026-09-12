# Phase 43 — Context budgeter & tokenizer parity

- **Layer:** BE
- **Depends on:** Phase 05 (evaluation & benchmark — **plan file not written yet**), Phase 41
  (conversation/message shapes for assembly inputs)
- **Unblocks:** Phase 44, 45, 46, 48
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §43 (context management), §44 (context limit
  metrics inputs), §70 (context consumption); `backend/solution.md` §1.2 (budget before every LLM
  call); `docs/architecture.md` §6.2 (every model call measured)

## 1. Goal

After this phase a shared **`contextBudgeter` module** can take an exact messages array (roles +
content + tool blocks), count tokens with a **tokenizer that matches the active model artifact**,
subtract reserved output and system/tool overhead, and either return a sendable payload or
**compact in the documented order**. If counting is unavailable or parity is not proven, every
caller gets a structured **`CONTEXT_ACCOUNTING_UNAVAILABLE`** error — no prompt is sent with guessed
sizes (backend §43, solution §1.2, architecture §6.2).

You can see it working in unit tests: under a fixture tokenizer, assembly fits budget; when input
exceeds budget, compaction steps run in order; when the tokenizer adapter throws, callers fail closed.

## 2. Why this phase is here

Phases 45 (LLM client), 46 (agent tools), and 48 (run budgets) must not each implement ad-hoc token
math. Requirements §43–§44 and §70 tie **reliable measurement** to whether a model call may start
at all. Phase 05 is meant to lock context capacity, tokenizer package, and reserved-output fractions
— that document does not exist yet, so this phase ships **interfaces, compaction logic, and tests with
injectable tokenizer doubles**, not production numbers.

Phase 41 defines what conversation rows look like; the budgeter accepts already-assembled prompt
parts from future loaders (Phase 44 / 50), not HTTP.

## 3. Scope

### In scope

- Module `src/platform/context/` (or `src/modules/contextBudget/`) with a single public entry:
  `prepareModelInput({ modelArtifactRef, purpose, segments, options })`.
- **Segment model:** typed blocks (system rules, user question, summary, turn, tool result, pinned
  fact, tool schema overhead) with stable ids for compaction audit trails.
- Token counting via **`TokenizerAdapter` interface** — production implementation wired only after
  Phase 05 names the npm package and artifact.
- Budget math:

```text
validatedContextCapacity   ← from evaluation config (Phase 05) — NOT invented here
  − reservedOutputTokens   ← evaluation — NOT invented here
  − systemAndToolSchemaTokens (measured)
  = maximumInputBudget

measuredInput <= maximumInputBudget → ok
measuredInput >  maximumInputBudget → compact (§4.3)
still over after compaction → structured failure (clarify/abstain codes owned by Phase 47/49)
```

- Compaction order **exactly** solution §1.2 / architecture §6.2:

  1. Preserve system/grounding, current question, clarification answers, pinned facts.
  2. Replace older turns with persisted summary segment (summary text supplied by caller — Phase 44
     persists it).
  3. Drop lower-ranked tool/document excerpts; keep source identifiers where required.
  4. Shrink oversized excerpts at natural boundaries.
  5. If minimum grounded prompt still exceeds budget → return `CONTEXT_BUDGET_EXCEEDED` with
     `retryability` and compaction log (caller decides clarify vs abstain).

- Fail closed: missing tokenizer, artifact mismatch, or Phase 05 config not loaded →
  `CONTEXT_ACCOUNTING_UNAVAILABLE` (catalog entry in `errorCatalog.js`).
- Return object includes: `messages` (for `ai` SDK), `measuredInputTokens`, `maximumInputBudget`,
  `reservedOutputTokens`, `validatedContextCapacity`, `compactionActions[]` — **only when measured**;
  omit numeric fields when accounting failed (never fabricate).

### Out of scope (owner phase)

- Persisting summaries / pinned facts — **Phase 44**.
- Calling Ollama or `ai` SDK — **Phase 45**.
- Tool byte budgets and cumulative run budgets — **Phase 48** (uses this module per call).
- LangGraph nodes — **Phases 47–49**.
- HTTP exposure of metrics — **Phase 44** on message payloads.
- Choosing Qwen context size (32K / 64K / 128K) — **Phase 05**.

## 4. Design

### 4.1 Configuration gate (Phase 05 blocker)

```text
contextModelConfig.js   ← reads evaluation artifact record when Phase 05 exists
  validatedContextCapacity: number | null
  reservedOutputTokens: number | null
  modelArtifactId: string | null
  tokenizerPackageId: string | null
```

Until Phase 05 populates this module, **`prepareModelInput` fails closed** with
`CONTEXT_ACCOUNTING_UNAVAILABLE` and `details.reason: 'evaluation_config_missing'`. Unit tests
inject a fake config object — production must not hardcode 32768 or similar.

### 4.2 Tokenizer adapter

```text
TokenizerAdapter
  countTokens(text: string): number
  countMessage(message: MessagePart): number
  assertArtifactMatch(modelArtifactId: string): void  → throws if mismatch
```

Production adapter is selected by Phase 05 benchmark (parity with Ollama-served artifact). **Do not
name a package in this document.** Tests use `FakeTokenizerAdapter` (1 char = 1 token or similar).

If `assertArtifactMatch` fails → `CONTEXT_ACCOUNTING_UNAVAILABLE` with
`details.reason: 'tokenizer_artifact_mismatch'`.

### 4.3 Compaction engine

Pure function `compactSegments(segments, budget, summarySegment, rankingHints)`:

- **Protected ids** never removed: system, current question, clarification answers, pinned facts
  (caller marks segment flags).
- **Turn replacement:** when over budget, oldest non-protected turn pairs collapse into
  `summarySegment` reference (caller must persist summary separately — Phase 44).
- **Tool results:** sort by `rank` ascending; drop lowest first; retain `{ sourceId, path }` stub
  rows when dropping body (solution §1.2 step 3).
- **Excerpt shrink:** binary search or paragraph-boundary shrink on remaining excerpts.

Each action appends to `compactionActions`: `{ action: 'drop_turn' | 'replace_with_summary' |
'shrink_excerpt' | 'drop_tool_body', segmentId, beforeTokens, afterTokens }` with **measured** counts
only.

### 4.4 Integration points (future)

| Caller | Purpose |
|---|---|
| Phase 45 `llmClient` | Every `generateText` / `streamText` |
| Phase 46 tools | Trim tool output before entering graph state |
| Phase 44 loader | Supply summary + pinned segments |
| Phase 49 VERIFY | Budget optional LLM verify call |

No HTTP handler imports this module directly in Phase 43.

## 5. Data model changes

**None.** Compaction logs are returned in memory to callers; persistence on `Message` is Phase 44.

Optional: none.

## 6. API contract — PROPOSED (needs approval before implementation)

**No public HTTP API.** Internal contract:

```json
{
  "prepareModelInputInput": {
    "modelArtifactRef": "string-from-phase-05",
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

## 7. Configuration & environment variables

**No new `.env` keys in this phase.** Model id and Ollama URL belong to Phase 45. Evaluation outputs
from Phase 05 are **named constants or a config module**, not env tunables (README D13, D3).

### Constants (not env — placeholders until Phase 05 binds values)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `CONTEXT_CONFIG_UNINITIALIZED` | — | `contextModelConfig.js` | Sentinel until Phase 05 |
| `COMPACTION_MAX_PASSES` | `8` | `contextBudgeter.compact.js` | Prevent infinite shrink loops |
| `EXCERPT_MIN_TOKENS` | TBD Phase 05 | `contextBudgeter.compact.js` | Floor when shrinking excerpts |

Do **not** assign TBD values during Phase 43 implementation without Phase 05 — tests use explicit
injected config.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/platform/context/contextModelConfig.js` | Gate for Phase 05 numbers |
| `backend/src/platform/context/tokenizerAdapter.js` | Interface + factory |
| `backend/src/platform/context/fakeTokenizerAdapter.js` | Test double |
| `backend/src/platform/context/contextBudgeter.js` | `prepareModelInput` entry |
| `backend/src/platform/context/contextBudgeter.compact.js` | Compaction order |
| `backend/src/platform/context/contextBudgeter.test.js` | Budget + compaction + fail-closed |
| `backend/src/platform/context/index.js` | Public exports |
| `backend/src/platform/errorCatalog.js` | Confirm `CONTEXT_ACCOUNTING_UNAVAILABLE`, add `CONTEXT_BUDGET_EXCEEDED` if missing |

## 9. Tests (≥ 80% line and branch)

### Unit

- With fake config + fake tokenizer: input under budget → no compaction, correct counts.
- Over budget → compaction order matches §4.3 (protected segments untouched).
- Summary replacement uses provided `summarySegment`; oldest turns removed first.
- Tool drop ordering by rank; stubs retain source ids.
- Excerpt shrink reduces tokens monotonically until budget met or floor hit.
- Missing Phase 05 config → `CONTEXT_ACCOUNTING_UNAVAILABLE`.
- Tokenizer throws → fail closed, no returned `messages`.
- Artifact mismatch → fail closed.

### Integration

- None required beyond unit scope unless a thin integration test loads fake config from disk fixture.

### Unhappy paths

- Empty segments with only protected blocks still over budget → `CONTEXT_BUDGET_EXCEEDED`.
- `COMPACTION_MAX_PASSES` exceeded → fail with budget exceeded, log last actions.

## 10. Definition of Done

- [ ] Single public `prepareModelInput` used by no HTTP routes yet.
- [ ] Compaction order matches solution §1.2 and architecture §6.2 verbatim.
- [ ] No hardcoded context capacity or reserved-output tokens in production code paths.
- [ ] No estimated tokens presented as measured usage.
- [ ] `CONTEXT_ACCOUNTING_UNAVAILABLE` on missing tokenizer/config/parity failure.
- [ ] ≥ 80% line and branch on `platform/context/*`.
- [ ] Phase 05 document referenced in README as dependency; implementation blocked until config exists
      OR tests use injection only.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.2: link to `contextBudgeter` module path.
- When Phase 05 completes: ADR for pinned model artifact + tokenizer package (Phase 45 may co-own).
- `backend/solution.md` §1.2 remains authoritative; update only if module names differ.

## 12. Risks & open questions

1. **Tokenizer npm package** — which package passes Phase 05 parity for the pinned Qwen artifact?
2. **Validated context capacity** — 32K vs 64K vs 128K operational cap (Phase 05 only).
3. **Reserved output tokens** — fixed constant vs percentage of capacity (Phase 05).
4. **Tool schema overhead** — measured once per run vs per call; where is schema text stored?
5. **Minimum grounded prompt** — who defines which segments are mandatory for "grounded" (Phase 47)?
6. **Phase 43 without Phase 05:** ship module with fail-closed default only, or delay merge until 05
   lands? (Plan assumes ship interfaces + fail-closed; numbers later.)
