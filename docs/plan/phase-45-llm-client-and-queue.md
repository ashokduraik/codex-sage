# Phase 45 — LLM client & bounded inference queue

- **Layer:** BE
- **Depends on:** Phase 43 (context budgeter — every call preflighted)
- **Unblocks:** Phase 47 (LangGraph nodes call LLM), Phase 42 auto-title (LLM path), Phase 44
  (LLM summary path if chosen)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §65 (streaming lifecycle — optional abort
  support for callers), §68 (token usage when reported), §69 (duration — hook for callers);
  `backend/solution.md` §2.1 (`ai` SDK + OpenAI-compatible `/v1`), §5.3 (swimlane — budget then
  `ai` call); `docs/architecture.md` §6 (OpenAI-compatible LLM as inference hop)

## 1. Goal

After this phase the conversation module owns one blessed path to the configured
**OpenAI-compatible** host: a shared `createOpenAI` factory used by the startup `GET /models`
probe, `generateText`, and `streamText`. Every generate/stream call runs Phase 43
`prepareModelInput` first. A **bounded in-process inference queue** (per API worker) keeps one
long stream from starving other runs. The service **never auto-pulls or upgrades** the model;
operators pin the artifact locally (solution §1.1).

You can see it working in unit tests with an injected `fetch` / SDK impl: queued jobs run in
order, abort cancels `streamText`, usage fields pass through when the mock returns them, and
missing URL / model id or a budgeter failure fails closed before calling the network.

## 2. Why this phase is here

LangGraph nodes (Phases 47–49) need one path to the OpenAI-compatible LLM — not ad-hoc `fetch`
per node. Solution §2.1 lists streaming, abort, structured output, and usage reporting as
reasons for `ai`. Phase 43 ensures prompts are measured; this phase ensures **calls** are
bounded and go through the same provider factory as startup.

Phase 05 locked CodeGraph/preview caps only. Artifact id and context capacity already come from
Phase 43 env + the startup probe (ADR 0034). Queue concurrency is locked at 1 (always host-safe)
until a reviewed `measure-llm-queue` run is promoted.

## 3. Scope

### In scope

- `generateText(request)` and `streamText(request)` on
  `backend/src/modules/conversation/llm.js`, exported from the conversation barrel.
- Shared `createLlmProvider(llm)` via `@ai-sdk/openai` `createOpenAI` — probe, generate, and
  stream all use it.
- Startup `assertLlmAvailable` rewritten onto that factory: `GET {baseURL}/models` through the
  provider’s `fetch` + auth (ADR 0034). No `generateText` ping at boot.
- Internal flow:

```text
prepareModelInput (43) → enqueue(inferenceTask) → provider.chat(modelId) → map usage + duration
```

- **Queue:** `INFERENCE_QUEUE_MAX_CONCURRENCY = 1`, `INFERENCE_QUEUE_MAX_DEPTH = 8` (named
  constants, not env). Global FIFO, per API worker (PM2 cluster — not fleet-wide; ADR 0004).
- **Abort:** optional `abortSignal` on the request. Phase 50 decides whether to pass one.
  Disconnect does **not** abort the run (architecture §6.1).
- **Usage mapping:** when SDK returns `usage`, map to `{ inputTokens, outputTokens, totalTokens }`;
  when absent, return `null` — never fabricate (backend §68).
- **Model identity:** expose configured `modelId` on results for persistence (Phase 49).
- **No `@fastify/rate-limit`**, no in-app HTTP rate limiting.
- Env already validated in `platform/config.js`: `LLM_BASE_URL`, `LLM_MODEL_ID`,
  `LLM_CONTEXT_CAPACITY`, optional `LLM_API_KEY`.
- Operator script `scripts/measure-llm-queue.mjs` — writes evaluation notes; does **not** change
  named constants.

### Out of scope (owner phase)

- LangGraph graph definition — **Phase 47**.
- SSE mapping of deltas — **Phase 50**.
- Installing or pulling models in code — **forbidden**.
- Raising concurrency above 1 — later reviewed measurement.
- Tokenizer package — still fail-closed; tests inject `countTokens`.
- Worker-process LLM — chat inference runs in the API process (architecture §6).

## 4. Design

### 4.1 Module layout

```text
backend/src/modules/conversation/llm.js          probe + factory + queue + generate/stream
backend/src/modules/conversation/index.js        export public surface
backend/tests/modules/conversation/llm.test.js   probe + client + queue
```

One production file. Overflow is `llm.helper.js` only after 1000 code lines. Do **not** add
`platform/llm/`, `llmProvider.js`, `inferenceQueue.js`, `llm.types.js`, or `modules/chat/`.

### 4.2 Provider factory

```js
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';

const provider = createOpenAI({
  baseURL: llm.baseUrl,
  apiKey: llm.apiKey || 'not-needed',
  fetch: options.fetch,
});
const model = provider.chat(llm.modelId);
```

Always `provider.chat(...)` (Chat Completions). Never `provider(modelId)` — AI SDK 5 defaults
to the OpenAI Responses API, which OpenAI-compatible hosts (Ollama `/v1`, vLLM) do not implement.

Dummy `apiKey` is SDK-only; `loadConfig()` still stores `null` when unset (ADR 0034). Never log
the key.

`@ai-sdk/openai` has no `models.list()`. The probe uses the factory’s `baseURL`, `apiKey`, and
`fetch` for `GET {baseURL}/models`.

### 4.3 Queue semantics

```text
enqueue(task):
  if waiting + running >= maxDepth → reject with LLM_QUEUE_FULL (temporary)
  wait for concurrency slot
  run task
  release slot
```

- **Fairness:** global FIFO.
- **Same process only** — not the Mongo job queue.
- Tests inject `{ maxDepth, maxConcurrency }` so depth/concurrency can be asserted without
  changing production constants.

### 4.4 Fail-closed gates

Before network I/O:

1. `llm.baseUrl` + `llm.modelId` present — else `LLM_CONFIG_UNAVAILABLE`.
2. `prepareModelInput` succeeded — `CONTEXT_ACCOUNTING_UNAVAILABLE` or `CONTEXT_BUDGET_EXCEEDED`
   propagate; no SDK call. Uses `getContextBudgetConfig` / injected tokenizer (no
   `contextModelConfig`).
3. Queue accepts the task — else `LLM_QUEUE_FULL`.

Structured errors only; no silent fallback to unbudgeted prompts.

### 4.5 Streaming result shape (internal)

```text
streamText result:
  textStream          AsyncIterable<string>
  usage               Promise<usage|null>
  durationMs          Promise<number>
  modelId             string
  contextMetrics      from prepareModelInput
```

Phase 50 maps chunks to SSE; this module does not write HTTP responses.

### 4.6 Operator responsibilities (documented, not coded)

- OpenAI-compatible host running with the configured model available (`solution §1.1`).
- Model id in env is the artifact id after the startup `GET /models` probe (ADR 0034).
- Never rely on a moving `latest` alias in production without re-measuring context.

## 5. Data model changes

**None.**

## 6. API contract

**No public HTTP API.** Internal:

```json
{
  "generateTextRequest": {
    "purpose": "understand | draft | verify | summarize | title",
    "segments": [],
    "summarySegment": "optional",
    "toolSchemaTokenOverhead": 0,
    "abortSignal": "optional AbortSignal",
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

`usage` is `null` when the provider omitted counts.

## 7. Configuration & environment variables

Read only in `platform/config.js` (already done — Phase 43 / ADR 0034). This phase does not add
env keys.

| Variable | Purpose |
|---|---|
| `LLM_BASE_URL` | OpenAI-compat root, e.g. `http://127.0.0.1:11434/v1` |
| `LLM_MODEL_ID` | Exact `id` from `GET /models` (artifact id) |
| `LLM_CONTEXT_CAPACITY` | Reviewed operational window (Phase 43) |
| `LLM_API_KEY` | Optional Bearer; omit when the host ignores auth |

**Not env:** `INFERENCE_QUEUE_MAX_CONCURRENCY = 1`, `INFERENCE_QUEUE_MAX_DEPTH = 8`,
`LLM_PROBE_TIMEOUT_MS = 10_000`, reserved output (Phase 43). No generate/stream timeout —
optional `abortSignal` only.

Never log env values.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/conversation/llm.js` | Probe + factory + queue + generate/stream |
| `backend/src/modules/conversation/index.js` | Export public client surface |
| `backend/src/platform/errorCatalog.js` | `LLM_CONFIG_UNAVAILABLE`, `LLM_QUEUE_FULL`, `LLM_PROVIDER_ERROR` |
| `backend/tests/modules/conversation/llm.test.js` | Probe + client + queue |
| `backend/tests/platform/errorCatalog.test.js` | New catalog codes |
| `backend/package.json` | Add `ai` and `@ai-sdk/openai` via `dependency-versions.mdc` |
| `scripts/measure-llm-queue.mjs` | Optional concurrency ladder (does not write constants) |
| `docs/evaluation/README.md` | Runbook row for the queue script |
| `docs/architecture.md` | Queue lives in `conversation/llm.js`, per worker |
| `backend/solution.md` | Module path + Chat Completions (`provider.chat`) |

## 9. Tests (≥ 80% line and branch)

### Unit

- Mock SDK: successful `generateText` returns usage when the mock provides it; `null` when not.
- `prepareModelInput` failure → no SDK invocation.
- Queue: third enqueue when injected depth=2 → `LLM_QUEUE_FULL`; concurrency cap respected.
- Abort signal aborts an in-flight stream (mock delayed stream).
- Missing `baseUrl` / `modelId` → `LLM_CONFIG_UNAVAILABLE` before network.
- Probe: injected `fetch` still asserts exact model-id match, `/v1/models` join, Bearer only
  when `apiKey` is set.

### Integration

- Not required. CI is mock-only (no live LLM host).

### Unhappy paths

- Provider / SDK throw → `LLM_PROVIDER_ERROR`, retryability `temporary`.
- No retry loop inside the client.

## 10. Definition of Done

- [x] All LLM I/O goes through `conversation/llm.js`; LangGraph not added yet but contract ready.
- [x] Every generate/stream call preceded by Phase 43 `prepareModelInput`.
- [x] Queue constants locked: concurrency 1, depth 8 (not guessed host capacity).
- [x] No model pull or download in codebase.
- [x] Usage never fabricated; `durationMs` is wall-clock around the SDK call.
- [x] `LLM_*` URL + model id already documented in `.env.example`.
- [x] Coverage ≥ 80% line and branch on `conversation/llm.js`.
- [x] Startup probe and generate/stream share one `createOpenAI` factory.

## 11. Documentation & ADR updates

- `backend/solution.md` §2.1, §5.3: module path `conversation/llm.js`; `provider.chat`.
- `docs/architecture.md` §6: inference queue in `conversation/llm.js`, API process, per worker.
- Pinned-artifact ADR stays ADR 0034 (model id = artifact id). Queue concurrency stays 1 until
  a reviewed `measure-llm-queue` run is promoted.

## 12. Risks & open questions

Resolved in this phase:

1. **SDK provider:** `ai` + `@ai-sdk/openai`; Chat Completions via `provider.chat`.
2. **API key:** optional in config (`null` when unset); SDK dummy only if the package requires a string.
3. **Queue limits:** concurrency 1, depth 8. Raise concurrency only after a reviewed measurement.
4. **Error codes:** `LLM_CONFIG_UNAVAILABLE`, `LLM_QUEUE_FULL`, `LLM_PROVIDER_ERROR` added. Keep
   `CONTEXT_*` for budgeter failures.
5. **Request timeout:** none for generate/stream; probe stays 10s. Optional `abortSignal` only.
6. **Fairness:** global FIFO.
7. **CI:** mock-only is acceptable (same as the existing probe tests).
