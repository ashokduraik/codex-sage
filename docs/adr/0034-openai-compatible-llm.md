# ADR 0034 — OpenAI-compatible LLM env, probe, and artifact id

- Status: Accepted
- Date: 2026-09-26
- Deciders: product owner
- Supersedes: [0033](./0033-qwen-artifact-and-context-budget.md)

## Context

ADR 0033 wired the API to Ollama-native endpoints (`/api/version`, `/api/tags`, `/api/show`)
and required `OLLAMA_*` env. Artifact identity was a GGUF digest from that probe.
The product should talk to any OpenAI-compatible `/v1` host (local Ollama `/v1`, vLLM,
OpenAI, or similar). Those servers expose `GET /models` and do not return a GGUF digest.

Compaction numbers from the reviewed Phase 43 run stay named constants.

## Decision

- Required env (no defaults). `loadConfig` throws `Invalid configuration` when any
  required key is missing or invalid:
  - `LLM_BASE_URL` — OpenAI-compatible root, e.g. `http://127.0.0.1:11434/v1`.
    The process does not append `/v1`.
  - `LLM_MODEL_ID` — exact `id` listed by `GET /models`.
  - `LLM_CONTEXT_CAPACITY` — operational window from a reviewed host run.
- Optional `LLM_API_KEY` — Bearer token when the host requires it. Empty or unset
  is `null`; there is no dummy default. Never log the key or include it in thrown messages.
- API startup calls `GET {LLM_BASE_URL}/models` (trailing slash normalized so `/v1`
  is not dropped). The process exits if the host is down or the model id is absent.
  The worker validates the same env and does not probe.
- Artifact id is the configured model id, held in memory after the probe. It is not
  env and is not a GGUF digest.
- Compaction tunables stay named constants: `RESERVED_OUTPUT_TOKENS = 457`,
  `EXCERPT_MIN_TOKENS = 27`, `COMPACTION_MAX_PASSES = 8`.
- `npm run measure-llm-context` uses `GET /models` and `POST /chat/completions`
  (`usage.prompt_tokens` / `usage.completion_tokens`). `--windows` are prompt-size
  targets, not provider-specific context knobs.
- No Node tokenizer package is pinned yet. Until a maintained package matches the
  fixture prompt-token values, `createTokenizerAdapter()` fails closed with
  `CONTEXT_ACCOUNTING_UNAVAILABLE`. Tests inject `countTokens`.

## Consequences

- `prepareModelInput` lives in `backend/src/modules/conversation/contextBudgeter.js`.
- `assertLlmAvailable` lives in `backend/src/modules/conversation/llm.js`.
- Over-budget after compaction is `CONTEXT_BUDGET_EXCEEDED`, not accounting-unavailable.
- Native Ollama `/api/*` is not used by the product or the measurement script.
- If an operator retags a moving model id, the artifact id changes on the next API
  start; `LLM_CONTEXT_CAPACITY` does not change until they edit env.

## Alternatives considered

- Keep `OLLAMA_*` aliases — rejected; one env surface only.
- Require `LLM_ARTIFACT_ID` as a separate pin — rejected; artifact id is the model id.
- Auto-append `/v1` to `LLM_BASE_URL` — rejected; operators set the OpenAI-compatible root.

## Escape hatch

Supersede when a tokenizer package passes the evaluation checklist, or when a new
measurement run changes the operational window operators put in env.
