# Phase 45 — LLM client & bounded inference queue

- **Layer:** BE
- **Depends on:** Phase 05 (evaluation — **unwritten**), Phase 43 (context budgeter — every call
  preflighted)
- **Unblocks:** Phase 47 (LangGraph nodes call LLM), Phase 42 auto-title (LLM path), Phase 44
  (LLM summary path if chosen)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §65 (streaming lifecycle — client abort support),
  §68 (token usage when reported), §69 (duration — hook for callers); `backend/solution.md` §2.1
  (`ai` SDK + OpenAI-compatible `/v1`), §5.3 (swimlane — budget then `ai` call);
  `docs/architecture.md` §6 (OpenAI-compatible LLM as inference hop)

## 1. Goal

After this phase a shared **`llmClient` module** wraps the Vercel **`ai` SDK** against a configured
**OpenAI-compatible** endpoint (`generateText`, `streamText`), always after Phase 43
`prepareModelInput`. A **bounded in-process inference queue** serializes/limit-concurrency so one
long chat stream cannot starve other users' runs. The service **never auto-pulls or upgrades** the
model; operators pin the artifact locally (solution §1.1).

You can see it working in integration tests with a mocked HTTP server: queued jobs run in order,
abort cancels `streamText`, usage fields pass through when the mock returns them, and missing Phase
05 pin/config fails closed before calling the network.

## 2. Why this phase is here

LangGraph nodes (Phases 47–49) need one blessed path to the OpenAI-compatible LLM — not ad-hoc `fetch` per node.
Solution §2.1 lists streaming, abort, structured output, and usage reporting as reasons for `ai`.
Phase 43 ensures prompts are measured; this phase ensures **calls** are bounded, observable, and
environment-configured.

Phase 05 must pin the evaluated Qwen artifact and record an ADR before production numbers and model
ids are trusted. Until then, the client reads **env for URL + model id** but refuses to run if
evaluation config is incomplete (same gate as Phase 43).

## 3. Scope

### In scope

- `llmClient.generateText(request)` and `llmClient.streamText(request)` where `request` includes
  `purpose`, `segments`, and optional `abortSignal`.
- Internal flow:

```text
prepareModelInput (43) → enqueue(inferenceTask) → ai SDK call → map usage + duration
```

- **`InferenceQueue`:** max depth + max concurrency — **values from Phase 05 evaluation**; until
  then constants module exports `null` placeholders and queue refuses start with
  `LLM_CONFIG_UNAVAILABLE` (PROPOSED code) or reuses `CONTEXT_ACCOUNTING_UNAVAILABLE` if unified —
  ask in §12.
- **Abort:** `AbortSignal` linked to client disconnect (Phase 50) propagates to SDK abort.
- **Usage mapping:** when SDK returns `usage`, map to `{ inputTokens, outputTokens, totalTokens }`;
  when absent, return `null` — never fabricate (backend §68).
- **Model identity:** expose configured `modelId` string on results for persistence (Phase 49).
- **No `@fastify/rate-limit`**, no in-app HTTP rate limiting (README §4, solution §13.1).
- Env: **`LLM_BASE_URL`**, **`LLM_MODEL_ID`**, optional **`LLM_API_KEY`** (per-environment); see §7.

### Out of scope (owner phase)

- LangGraph graph definition — **Phase 47**.
- SSE mapping of deltas — **Phase 50**.
- Installing or pulling models in code — **forbidden** (operator installs the host artifact).
- Choosing `@ai-sdk/openai` vs another OpenAI-compatible adapter package — **open question** §12.
- Pin ADR content — written when Phase 05 completes (this doc describes the hook only).
- Worker-process LLM — chat inference runs in API process per architecture §6.

## 4. Design

### 4.1 Module layout

```text
src/platform/llm/
  index.js                 public: generateText, streamText, getLlmConfigStatus
  llmClient.js             orchestrates budgeter + queue + SDK
  llmProvider.js           createOpenAI-compatible client from env
  inferenceQueue.js        bounded queue + concurrency semaphore
  llm.types.js             request/result shapes
  llmClient.test.js
  inferenceQueue.test.js
```

### 4.2 Provider factory (PROPOSED — pending §12 Q1)

Illustrative pattern from solution §5.3 (JavaScript, not TypeScript):

```js
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';

const client = createOpenAI({
  baseURL: config.llm.baseUrl,
  apiKey: config.llm.apiKey ?? 'not-needed',
});
const model = client(config.llm.modelId);
```

**Do not implement** until user confirms package choice (`@ai-sdk/openai` vs another
OpenAI-compatible adapter). `apiKey` is omitted or a dummy string when the host ignores it.

### 4.3 Queue semantics

```text
enqueue(task):
  if queueDepth >= maxDepth → reject with LLM_QUEUE_FULL (retryable)
  wait for concurrency slot
  run task
  release slot
```

- **Fairness:** FIFO per org optional — **open question**; default FIFO global for MVP unless
  product asks per-tenant fairness.
- **Same process only** — not Mongo job queue (architecture §2).
- Depth/concurrency numbers: **Phase 05 evaluation** — module reads from shared eval config; do not
  invent `maxDepth: 10`.

### 4.4 Fail-closed gates

Before network I/O:

1. Phase 05 / `contextModelConfig` has valid artifact + capacity (Phase 43).
2. `prepareModelInput` succeeded (no `CONTEXT_ACCOUNTING_UNAVAILABLE`).
3. `llm.baseUrl` + `llm.modelId` present in validated env config.
4. Queue accepts task (depth/concurrency).

Structured errors only; no silent fallback to unbudgeted prompts.

### 4.5 Streaming result shape (internal)

```text
streamText result async iterable:
  onDelta(textChunk)
  onFinish({ usage, durationMs, modelId, contextMetrics from budgeter })
```

Phase 50 maps chunks to SSE; this module does not write HTTP responses.

### 4.6 Operator responsibilities (documented, not coded)

- OpenAI-compatible host running with the configured model available (`solution §1.1`).
- Model id in env matches Phase 05 pinned artifact after evaluation.
- Never rely on `latest` alias in production (ADR when Phase 05 completes).

## 5. Data model changes

**None.**

## 6. API contract — PROPOSED (needs approval before implementation)

**No public HTTP API.** Internal:

```json
{
  "generateTextRequest": {
    "purpose": "understand | verify | summarize | title",
    "segments": [],
    "abortSignal": "AbortSignal",
    "outputSchema": "optional JSON schema for structured output"
  },
  "generateTextResult": {
    "text": "...",
    "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
    "durationMs": 0,
    "modelId": "string",
    "contextMetrics": {}
  },
  "streamTextResult": {
    "textStream": "AsyncIterable<string>",
    "usage": "Promise<usage|null>",
    "durationMs": "Promise<number>",
    "modelId": "string",
    "contextMetrics": {}
  },
  "errors": [
    "CONTEXT_ACCOUNTING_UNAVAILABLE",
    "CONTEXT_BUDGET_EXCEEDED",
    "LLM_CONFIG_UNAVAILABLE",
    "LLM_QUEUE_FULL",
    "LLM_PROVIDER_ERROR"
  ]
}
```

`usage` null when provider omitted counts.

## 7. Configuration & environment variables

Read only in `platform/config.js` (single env loader rule).

| Variable | Purpose |
|---|---|
| `LLM_BASE_URL` | OpenAI-compat root, e.g. `http://127.0.0.1:11434/v1` |
| `LLM_MODEL_ID` | Model name passed to SDK (artifact id) |
| `LLM_CONTEXT_CAPACITY` | Reviewed operational window (Phase 43) |
| `LLM_API_KEY` | Optional Bearer; omit when the host ignores auth |

Document in `backend/.env.example` and mirror to `backend/.env` on change (`env-example-sync.mdc`).

**Not env:** queue max depth, max concurrency, request timeout, reserved output — Phase 05 → named
constants in `inferenceQueue.js` / `contextModelConfig.js`.

Never log env values.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/platform/llm/index.js` | Public exports |
| `backend/src/platform/llm/llmProvider.js` | SDK client factory |
| `backend/src/platform/llm/llmClient.js` | Budgeter + queue + SDK |
| `backend/src/platform/llm/inferenceQueue.js` | Bounded queue |
| `backend/src/platform/llm/llm.types.js` | Shapes |
| `backend/src/platform/llm/*.test.js` | Unit + mocked provider tests |
| `backend/src/platform/config.js` | Validate `LLM_*` URL + model id (already done) |
| `backend/.env.example` | Document `LLM_*` vars |
| `backend/package.json` | Add `ai` and provider package **at implementation time** via `dependency-versions.mdc` |

## 9. Tests (≥ 80% line and branch)

### Unit

- Mock SDK: successful `generateText` returns usage when mock provides it; null when not.
- `prepareModelInput` failure → no SDK invocation.
- Queue: third enqueue when depth=2 → `LLM_QUEUE_FULL`; concurrency cap respected under load test.
- Abort signal aborts in-flight stream (mock delayed stream).
- Missing env model id → `LLM_CONFIG_UNAVAILABLE` at client construction or first call.

### Integration

- HTTP mock OpenAI `/v1/chat/completions` — optional if SDK mock sufficient for coverage.

### Unhappy paths

- Provider 500 → `LLM_PROVIDER_ERROR`, retryability `temporary`.
- Network error → same; no retry loop inside client (callers may retry).

## 10. Definition of Done

- [ ] All LLM I/O goes through `llmClient`; LangGraph not added yet but contract ready.
- [ ] Every call preceded by Phase 43 `prepareModelInput`.
- [ ] Queue depth/concurrency not hardcoded with invented production values.
- [ ] No model pull or download in codebase.
- [ ] Usage and duration never fabricated.
- [ ] `LLM_*` URL + model id documented in `.env.example`.
- [ ] Coverage ≥ 80% line and branch on `platform/llm/*`.
- [ ] ADR for pinned model deferred until Phase 05 — placeholder note in `docs/adr/README.md` only if
      needed.

## 11. Documentation & ADR updates

- `backend/solution.md` §2.1, §5.3: align module names if different.
- **When Phase 05 completes:** new ADR — pinned Qwen artifact, tokenizer parity reference, operational
  context cap, queue concurrency choice.
- `docs/architecture.md` §6: note inference queue lives in API process.

## 12. Risks & open questions

1. **SDK provider:** `@ai-sdk/openai` pointed at `LLM_BASE_URL` vs another OpenAI-compatible adapter?
2. **API key:** optional `LLM_API_KEY` is decided (omit when unset); SDK dummy only if the package requires a string.
3. **Queue limits:** max depth and concurrency from Phase 05 — what are evaluation targets?
4. **Error code:** separate `LLM_CONFIG_UNAVAILABLE` / `LLM_QUEUE_FULL` vs extend existing catalog?
5. **Request timeout:** named constant value — Phase 05 or separate open question?
6. **Fairness:** global FIFO vs per-`orgId` fair queue when one tenant runs long drafts?
7. **CI:** Phase 63 may skip a live LLM host — confirm mock-only CI path is acceptable.
