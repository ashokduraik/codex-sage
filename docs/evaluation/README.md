# Evaluation runs

Operator measurements that lock **numbers** (context window, tokenizer parity inputs,
CodeGraph scale). Re-run these on each environment. Do not treat a laptop cap as a
server cap, or the reverse.

The application does **not** read these files at runtime. After you review a run,
promote values into named constants on the owning module.

| Script | Writes | When to run |
|---|---|---|
| [run-phase-05-codegraph.mjs](./run-phase-05-codegraph.mjs) | [phase-05-codegraph.md](./phase-05-codegraph.md), [phase-05-codegraph.raw.json](./phase-05-codegraph.raw.json) | After CodeGraph adapter or preview-cap changes |
| [`scripts/measure-llm-context.mjs`](../../scripts/measure-llm-context.mjs) (`npm run measure-llm-context`) | [phase-43-context.md](./phase-43-context.md), [phase-43-context.raw.json](./phase-43-context.raw.json) | New host, new provider version, new model id, RAM/GPU change, or a suspected wrong context cap |

---

## Phase 43 — context capacity and tokenizer parity fixtures

Reusable. Same command on every machine that will serve the chat model through an
OpenAI-compatible `/v1` host.

### Prerequisites

1. Start a server that implements `GET /models` and `POST /chat/completions`.
   A local Ollama daemon with OpenAI `/v1` enabled is one example host.
2. Confirm the model id is listed (replace the URL if the host is not local):

```bash
export LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:11434/v1}"
curl -sS "$LLM_BASE_URL/models"
```

The script fails closed if the host is down or the model id is missing. It does not
pull or download a model and does not `npm install` a tokenizer.

### Run (from the repository root)

```bash
npm run measure-llm-context -- \
  --base-url "${LLM_BASE_URL:-http://127.0.0.1:11434/v1}" \
  --model qwen3.8:latest
```

Equivalent: `node scripts/measure-llm-context.mjs` with the same flags. Extra flags
must follow `--` when using npm. Optional `--api-key` (or `LLM_API_KEY`) sends Bearer.

Optional flags:

| Flag | Default | Purpose |
|---|---|---|
| `--base-url` | `http://127.0.0.1:11434/v1` | OpenAI-compatible root |
| `--model` | `qwen3.8:latest` | Exact `id` from `GET /models` (this is the artifact id) |
| `--api-key` | unset / `LLM_API_KEY` | Optional Bearer token |
| `--windows` | `32768,65536,131072` | Prompt-size targets (not a provider `num_ctx` knob) |
| `--out-dir` | `docs/evaluation` | Where `phase-43-context.md` and `.raw.json` are overwritten |
| `--skip-ladder` | off | Skip the capacity generate ladder |
| `--parity-only` | off | Artifact pin + parity fixtures only (cheap re-check) |
| `--help` | | Flag list |

The first generate on a host may load weights. A full ladder can take tens of minutes.
If a step OOM or errors, the script **stops** and keeps the last passing window — it
does not invent a larger cap.

### Read the output

1. Open [phase-43-context.md](./phase-43-context.md) (latest run only; older runs are in git).
2. Confirm **artifact id**, **validatedContextCapacity**, **reservedOutputTokens**, and
   **EXCERPT_MIN_TOKENS**.
3. Treat vendor advertised context as marketing until that window appears as a passing
   ladder step on **this** machine.
4. The `:latest` suffix is acceptable only for measurement. The artifact id is the
   configured model id — re-measure if the host retags it.

The checked-in `phase-43-context.md` from 2026-09-26 used the previous native Ollama
`/api/generate` protocol. Re-run this script to replace it with OpenAI `/v1` usage.

### Re-run when

- The machine, RAM, or GPU changes
- The LLM host or model id changes
- Before go-live on a new host
- After an OOM or `CONTEXT_ACCOUNTING_UNAVAILABLE` that looks like a wrong cap

### Promote numbers into the product

Reviewed capacity becomes `LLM_CONTEXT_CAPACITY` in the API env. Reserved output and
excerpt floor stay named constants on `contextBudgeter.js` after review.
The script never edits application source.

### Tokenizer package checklist (not done by this script)

Pick a Node tokenizer only after both `dependency-versions.mdc` checks pass
(`npm view <pkg> version`, `deprecated`, publish + upstream activity in the last
12 months). Prove parity against the fixture `prompt_tokens` values in the latest
`phase-43-context.raw.json`. If no maintained package matches, fail closed
and ask — do not ship guessed counts.

---

## Phase 05 — CodeGraph and preview caps

```bash
node docs/evaluation/run-phase-05-codegraph.mjs
```

D4: measures this product’s fixtures and `backend/src` only. See
[phase-05-codegraph.md](./phase-05-codegraph.md).
