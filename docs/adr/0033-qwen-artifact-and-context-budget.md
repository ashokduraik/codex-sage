# ADR 0033 — Ollama env, live digest, and context-budget numbers

- Status: Superseded by [0034](./0034-openai-compatible-llm.md)
- Date: 2026-09-26
- Deciders: product owner

## Context

Backend §43–§44 and §70 require every model call to be measured with a tokenizer that
matches the active artifact. Vendor advertised context (256K on this Qwen3.8 GGUF) is
not an operational limit until a host ladder passes.

`npm run measure-llm-context` recorded a run on 2026-09-26
(`docs/evaluation/phase-43-context.md`). Connection details differ per machine.
The moving `:latest` tag is not a stable artifact id; Ollama already returns the
loaded digest after connect.

## Decision

- Required env (no defaults). `loadConfig` throws `Invalid configuration` when any
  is missing or invalid:
  - `OLLAMA_BASE_URL` — Ollama origin, e.g. `http://127.0.0.1:11434`
  - `OLLAMA_MODEL_ID` — already-pulled tag or name, e.g. `qwen3.8:latest`
  - `OLLAMA_CONTEXT_CAPACITY` — operational window from a reviewed host run
    (example on the machine that produced the 2026-09-26 note: `131072`).
    Advertised 256K is not the cap.
- API startup connects to `OLLAMA_BASE_URL` (`GET /api/version`, `GET /api/tags`,
  `POST /api/show` for `OLLAMA_MODEL_ID`). The process exits if the daemon is down,
  the model is missing, or the response has no digest. The worker validates the
  same env and does not probe.
- Artifact digest is taken from that Ollama response and held in memory for the
  budgeter. It is not hardcoded and is not an env var.
- Compaction tunables stay named constants: `RESERVED_OUTPUT_TOKENS = 457`,
  `EXCERPT_MIN_TOKENS = 27`, `COMPACTION_MAX_PASSES = 8`.
- No Node tokenizer package is pinned yet. Until a maintained package matches the
  fixture `prompt_eval_count` values, `createTokenizerAdapter()` fails closed with
  `CONTEXT_ACCOUNTING_UNAVAILABLE`. Tests inject `countTokens`.

## Consequences

- `prepareModelInput` lives in `backend/src/modules/conversation/contextBudgeter.js`.
- `assertOllamaAvailable` lives in `backend/src/modules/conversation/ollama.js`.
- Over-budget after compaction is `CONTEXT_BUDGET_EXCEEDED`, not accounting-unavailable.
- If an operator retags `:latest` to different weights, the live digest changes on
  the next API start; `OLLAMA_CONTEXT_CAPACITY` does not change until they edit env.

## Alternatives considered

- Treat advertised 256K as the cap — rejected; it was not on the passing ladder.
- Hardcode the digest from the evaluation note — rejected; Ollama returns it after connect.
- Ship `tiktoken` or a guessed Qwen wrapper — rejected; parity is unproven.

## Escape hatch

Supersede when a tokenizer package passes the evaluation checklist, or when a new
measurement run changes the operational window operators put in env.
