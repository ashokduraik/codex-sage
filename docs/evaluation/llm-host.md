# LLM host measurement (latest run)

Recorded: 2026-10-17T14:33:36.467Z
Host: Ashoks-MacBook-Pro.local (darwin arm64)
Artifact: `qwen3.8:latest`

## Recommended env

| Key | Value |
|---|---|
| LLM_CONTEXT_CAPACITY | 131072 |
| LLM_QUEUE_MAX_CONCURRENCY | 4 |
| LLM_RUN_MAX_CUMULATIVE_INPUT_TOKENS | 888 |
| LLM_RUN_MAX_CUMULATIVE_OUTPUT_TOKENS | 635 |
| LLM_RUN_MAX_CUMULATIVE_TOOL_RESULT_BYTES | 19840 |
| LLM_RUN_MAX_TOTAL_CALLS | 30 |
| LLM_RUN_MAX_WALL_TIME_MS | 41877 |

## Constants (contextBudgeter.js)

| Constant | Value |
|---|---|
| RESERVED_OUTPUT_TOKENS | 807 |
| EXCERPT_MIN_TOKENS | 25 |

Promote by editing `backend/.env` / `.env.example` (and constants above). This script never edits them.
