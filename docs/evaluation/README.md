# Evaluation runs

Operator measurements that lock **numbers** (LLM host capacity, queue concurrency,
chat run budgets, CodeGraph scale). Re-run these on each environment. Do not treat
a laptop cap as a server cap, or the reverse.

The application does **not** read these markdown/JSON files at runtime. After you
review a run, copy the printed env lines into `backend/.env` and
`backend/.env.example`.

| Script | Writes | When to run |
|---|---|---|
| [`scripts/measure-llm-host.mjs`](../../scripts/measure-llm-host.mjs) (`npm run measure-llm-host`) | [llm-host.md](./llm-host.md), [llm-host.raw.json](./llm-host.raw.json) + **console recommendations** | New host, new model id, RAM/GPU change, or before go-live |
| [run-phase-05-codegraph.mjs](./run-phase-05-codegraph.mjs) | [phase-05-codegraph.md](./phase-05-codegraph.md), [phase-05-codegraph.raw.json](./phase-05-codegraph.raw.json) | After CodeGraph adapter or preview-cap changes |
| [run-answer-quality.mjs](./run-answer-quality.mjs) | [answer-quality.md](./answer-quality.md), [answer-quality.raw.json](./answer-quality.raw.json) | After chat graph / retrieval / citation changes; needs LLM + knowledge-ready dogfood project |

---

## LLM host (context + queue + run budgets)

One script measures everything needed for the chat model on this machine.

### Prerequisites

1. Start a server that implements `GET /models` and `POST /chat/completions`.
2. Confirm the model id is listed:

```bash
export LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:11434/v1}"
curl -sS "$LLM_BASE_URL/models"
```

### Run (from the repository root)

```bash
npm run measure-llm-host -- \
  --base-url "${LLM_BASE_URL:-http://127.0.0.1:11434/v1}" \
  --model qwen3.8:latest
```

The script prints recommended `backend/.env` values to the console. Copy them into
`backend/.env` and `backend/.env.example`. It also writes `docs/evaluation/llm-host.md`
for git history. It never edits `.env` or application source.

Optional flags: `--skip-context`, `--skip-queue`, `--skip-run-budgets`, `--windows`,
`--queue-levels`, `--run-iterations`, `--api-key`, `--out-dir`, `--help`.

### Env keys promoted from this run

| Key | Meaning |
|---|---|
| `LLM_CONTEXT_CAPACITY` | Last passing context ladder window |
| `LLM_QUEUE_MAX_CONCURRENCY` | Last fully successful parallel completion count |
| `LLM_RUN_MAX_CUMULATIVE_INPUT_TOKENS` | Cross-call input token budget |
| `LLM_RUN_MAX_CUMULATIVE_OUTPUT_TOKENS` | Cross-call output token budget |
| `LLM_RUN_MAX_CUMULATIVE_TOOL_RESULT_BYTES` | Cumulative tool excerpt bytes |
| `LLM_RUN_MAX_TOTAL_CALLS` | Model tool-choice + tool execution count |
| `LLM_RUN_MAX_WALL_TIME_MS` | Wall-time deadline for one chat run |

The console also recommends `RESERVED_OUTPUT_TOKENS` and `EXCERPT_MIN_TOKENS` for
`contextBudgeter.js` named constants (not env).

Run budgets are **not** equal to `LLM_CONTEXT_CAPACITY` — that value is per-prompt only.

### Re-run when

- The machine, RAM, or GPU changes
- The LLM host or model id changes
- Before go-live on a new host

---

## Phase 05 — CodeGraph and preview caps

```bash
node docs/evaluation/run-phase-05-codegraph.mjs
```

D4: measures this product’s fixtures and `backend/src` only. See
[phase-05-codegraph.md](./phase-05-codegraph.md).

---

## Answer quality (citation accuracy + abstain)

Operator script (Phase 55). Not a Vitest CI gate — needs a running API, LLM host, and a
knowledge-ready project whose indexed tree includes `backend/src` (dogfood). Pure scorer
unit tests live in `backend/tests/evaluation/answerQualityScore.test.js`.

Gold cases: [answer-quality/cases.json](./answer-quality/cases.json) (path + line citations
and abstain prompts).

### Run (from the repository root)

```bash
node docs/evaluation/run-answer-quality.mjs \
  --base-url "${API_BASE_URL:-http://127.0.0.1:3000/api/v1}" \
  --project-id "<knowledge-ready-project-id>" \
  --token "<access-jwt>"
```

Optional: `--cases`, `--out-dir`, `--help`.

### Scoring

- **Citation hit:** same normalized path and overlapping `startLine`/`endLine`.
- **Answer case pass:** citation recall ≥ 1.0 (every gold citation hit).
- **Abstain case pass:** terminal abstain with no invented evidence.
- Suite exits non-zero if citation-pass rate or abstain-pass rate is below **0.8**.

Re-pin gold line numbers in `cases.json` when the cited symbols move; keep case `id`s stable.
