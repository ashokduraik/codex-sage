# ADR 0038 — Qwen3 Node tokenizer for context budget

- Status: Accepted
- Date: 2026-10-18
- Deciders: product owner
- Supersedes: [0034](./0034-openai-compatible-llm.md) (tokenizer fail-closed clause only)

## Context

ADR 0034 left production token counting fail-closed until a maintained Node package
matched fixture `prompt_tokens` from the OpenAI-compatible host measurement. Grounded
chat calls `generateText` → `prepareModelInput` → `countTokensForBudget`, so streams
could not run. Phase 43 fixtures and `scripts/measure-llm-host.mjs` `PARITY_FIXTURES`
define the parity texts; checked-in host counts live in
`docs/evaluation/llm-host.raw.json`.

## Decision

- Pin **`@lenml/tokenizer-qwen3`** (latest stable at install; currently 3.7.2) in
  `backend/`. Dependency checks follow `dependency-versions.mdc`.
- Production surface stays **`countTokensForBudget(text)`** in
  `backend/src/modules/conversation/tokenCount.js` — lazy `fromPreTrained()` singleton,
  `encode(text, { add_special_tokens: false })` length (segment **content** only;
  the budgeter does not apply chat templates).
- **Parity gate:** for each fixture, encode
  `` `<|im_start|>user\n${content}<|im_end|>\n<|im_start|>assistant\n` ``
  (same wrap the host uses for chat-completions `prompt_tokens`) and require
  `|nodeCount - hostPromptTokens| <= TOKENIZER_PARITY_TOLERANCE_TOKENS` where
  `TOKENIZER_PARITY_TOLERANCE_TOKENS = 8`. Host baselines: system 29, turns 33,
  toolJson 42, codeExcerpt 47.
- Init or encode failure → log original + `cause`, throw
  `CONTEXT_ACCOUNTING_UNAVAILABLE` with `details.reason: 'tokenizer_unavailable'`.
- Artifact id mismatch remains in `contextBudgeter.js`
  (`tokenizer_artifact_mismatch`).

## Consequences

- Grounded chat can measure prompts and compact before LLM calls.
- Context-budgeter unit tests may keep mocking `tokenCount.js`; production uses the
  real package.
- Changing model family requires a new parity run and likely a new package or ADR.

## Alternatives considered

- Character heuristic (`length / 4`) — rejected; fails closed requirements and drifts
  from the host tokenizer.
- `@huggingface/tokenizers` + vendored `tokenizer.json` — heavier ops; deferred while
  `@lenml/tokenizer-qwen3` passes parity.
- Counting with chat templates in production — rejected; budgeter measures segment
  content; wrap is only for the parity gate vs host `prompt_tokens`.

## Escape hatch

Supersede when the active model family is no longer Qwen3 / `qwen35`, the package
fails a new host parity run, or operators switch to a different tokenizer that
passes the same fixture checklist within the recorded tolerance.
