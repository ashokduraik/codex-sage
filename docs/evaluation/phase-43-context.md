# Phase 43 — Context measurement (latest run)

This file is **overwritten** on every script run. Older numbers are in git history.
Re-run on every machine (and after artifact / provider / RAM changes). Runbook:
[docs/evaluation/README.md](./README.md).

Note: this checked-in run used the previous native Ollama `/api/generate` protocol.
Re-run `npm run measure-llm-context` to replace it with OpenAI-compatible `/v1` usage.

Recorded **2026-09-26T16:14:03.675Z** on `Ashoks-MacBook-Pro.local` (darwin arm64, Node v26.5.0).
Ollama **0.33.2**. Host memory 51539607552 bytes.

Command:

```bash
npm run measure-llm-context -- 
```

The requested tag ends in `:latest`. Pin the digest below in ADRs and app config — do not ship the moving tag as the artifact id.

## Artifact

| Field | Value |
|---|---|
| Requested model | `qwen3.8:latest` |
| Digest | `22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643` |
| Quant / family | Q4_K_M / qwen35 |
| Parameter size | 27.3B |
| Advertised context_length | 262144 |
| tokenizer.ggml.model / pre | gpt2 / qwen35 |

Advertised context is **not** the operational cap. Use `validatedContextCapacity` below.

## Capacity ladder

Fill ratio 0.25 of each `num_ctx` (KV cache is still allocated for the full window).
Stopped at the first failure. Do not invent a larger window than the last pass.

| num_ctx | result | prompt_eval_count | eval_count | elapsed_ms | error |
|---|---|---|---|---|---|
| 32768 | pass | 5194 | 2 | 16978 |  |
| 65536 | pass | 10368 | 2 | 36592 |  |
| 131072 | pass | 20715 | 2 | 75828 |  |

**validatedContextCapacity:** 131072

## Reserved output

DRAFT-like generate with `num_predict=1024`, margin 256.

| Field | Value |
|---|---|
| ok | true |
| eval_count | 201 |
| recommended reservedOutputTokens | 457 |

## Parity fixtures

Ollama `prompt_eval_count` for fixed texts. A later Node tokenizer must match these
counts within the tolerance recorded when that package is chosen.

| fixture | prompt_eval_count | ok |
|---|---|---|
| system | 31 | yes |
| turns | 35 | yes |
| toolJson | 44 | yes |
| codeExcerpt | 49 | yes |

## Excerpt floor

Stub `[source: src/modules/access/auth.js lines 12-40]` → prompt_eval_count **27**.
Recommended `EXCERPT_MIN_TOKENS`: 27.

## Promote numbers

Do not copy another host’s cap. After reviewing this run, set named constants on
`backend/src/modules/conversation/contextBudgeter.js` (implementation phase). This
script never edits application source.
