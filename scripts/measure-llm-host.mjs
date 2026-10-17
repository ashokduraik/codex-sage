/**
 * Single LLM-host measurement: context capacity, inference-queue concurrency,
 * and chat run budgets. Prints recommended backend/.env values to the console.
 *
 * Usage (repo root):
 *   npm run measure-llm-host
 *   npm run measure-llm-host -- --base-url http://127.0.0.1:11434/v1 --model qwen3.8:latest
 *
 * See docs/evaluation/README.md. Does not edit application source or .env.
 */
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default OpenAI-compatible root. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

/** Default chat model id. */
const DEFAULT_MODEL = 'qwen3.8:latest';

/** Context ladder windows. */
const DEFAULT_WINDOWS = Object.freeze([32768, 65536, 131072]);

/** Queue concurrency ladder. */
const DEFAULT_QUEUE_LEVELS = Object.freeze([1, 2, 4]);

/** Run-budget soak iterations. */
const DEFAULT_RUN_ITERATIONS = 12;

const FILLER_CHARS_PER_TOKEN = 4;
const LADDER_FILL_RATIO = 0.25;
const LADDER_MAX_TOKENS = 8;
const RESERVED_OUTPUT_MAX_TOKENS = 1024;
const RESERVED_OUTPUT_MARGIN_TOKENS = 256;
const QUEUE_MAX_TOKENS = 8;
const TOOL_CHOICE_MAX_TOKENS = 64;
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
const HEADROOM_FACTOR = 1.25;
const DRAFT_RESERVE_FRACTION = 0.35;
const FIXTURE_EXCERPT_BYTE_SIZES = Object.freeze([512, 1024, 2048, 4096, 8192]);

const FILLER_UNIT =
  'The authentication middleware validates JWT claims before the handler runs.\n';
const EXCERPT_STUB = '[source: src/modules/access/auth.js lines 12-40]';

const PARITY_FIXTURES = Object.freeze({
  system:
    'You are a grounded project assistant. Cite evidence ids. Do not invent paths or APIs.',
  turns:
    'User: How does login refresh the session?\nAssistant: Refresh uses the httpOnly cookie and rotates the hash.',
  toolJson: JSON.stringify({
    tool: 'explore_code',
    path: 'backend/src/modules/access/auth.js',
    excerpt: 'export async function refreshSession(request) { return rotate(request); }',
  }),
  codeExcerpt: [
    'export async function refreshSession(request) {',
    '  const session = await loadSession(request.cookies.refresh);',
    '  if (!session) throw unauthorized();',
    '  return rotate(session);',
    '}',
  ].join('\n'),
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @returns {void}
 */
function printHelp() {
  process.stdout.write(`LLM host measurement (context + queue + run budgets).

Usage:
  npm run measure-llm-host -- [options]
  node scripts/measure-llm-host.mjs [options]

Options:
  --base-url <url>     OpenAI-compatible root (default ${DEFAULT_BASE_URL})
  --model <name>       Model id from GET /models (default ${DEFAULT_MODEL})
  --api-key <key>      Optional Bearer (else LLM_API_KEY)
  --windows <list>     Context ladder windows (default ${DEFAULT_WINDOWS.join(',')})
  --queue-levels <list> Concurrency steps (default ${DEFAULT_QUEUE_LEVELS.join(',')})
  --run-iterations <n> Tool-choice soak count (default ${DEFAULT_RUN_ITERATIONS})
  --skip-context       Skip capacity ladder / reserved / parity / excerpt
  --skip-queue         Skip concurrency ladder
  --skip-run-budgets   Skip run-budget soak
  --out-dir <dir>      Write llm-host.md + .raw.json (default docs/evaluation)
  --help               Show this help

Prints recommended backend/.env keys to the console. Does not edit .env or src/.
`);
}

/**
 * @param {string[]} argv CLI args.
 * @returns {object}
 */
function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    apiKey: null,
    windows: [...DEFAULT_WINDOWS],
    queueLevels: [...DEFAULT_QUEUE_LEVELS],
    runIterations: DEFAULT_RUN_ITERATIONS,
    skipContext: false,
    skipQueue: false,
    skipRunBudgets: false,
    outDir: path.join(repoRoot, 'docs/evaluation'),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else if (flag === '--skip-context') {
      options.skipContext = true;
    } else if (flag === '--skip-queue') {
      options.skipQueue = true;
    } else if (flag === '--skip-run-budgets') {
      options.skipRunBudgets = true;
    } else if (flag === '--base-url' && next) {
      options.baseUrl = next.replace(/\/$/, '') || next;
      index += 1;
    } else if (flag === '--model' && next) {
      options.model = next;
      index += 1;
    } else if (flag === '--api-key' && next) {
      options.apiKey = next;
      index += 1;
    } else if (flag === '--windows' && next) {
      options.windows = next.split(',').map((part) => Number(part.trim())).filter((n) => n > 0);
      index += 1;
    } else if (flag === '--queue-levels' && next) {
      options.queueLevels = next.split(',').map((part) => Number(part.trim())).filter((n) => n > 0);
      index += 1;
    } else if (flag === '--run-iterations' && next) {
      options.runIterations = Number(next);
      index += 1;
    } else if (flag === '--out-dir' && next) {
      options.outDir = path.isAbsolute(next) ? next : path.resolve(repoRoot, next);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete flag: ${flag}. See --help.`);
    }
  }
  if (options.windows.length === 0) {
    throw new Error('--windows must list at least one positive integer.');
  }
  if (options.queueLevels.length === 0) {
    throw new Error('--queue-levels must list at least one positive integer.');
  }
  if (!Number.isFinite(options.runIterations) || options.runIterations < 1) {
    throw new Error('--run-iterations must be a positive integer.');
  }
  if (!options.apiKey) {
    const fromEnv = typeof process.env.LLM_API_KEY === 'string' ? process.env.LLM_API_KEY.trim() : '';
    options.apiKey = fromEnv === '' ? null : fromEnv;
  }
  return Object.freeze(options);
}

/**
 * @param {string} baseUrl Root.
 * @param {string} relativePath Path.
 * @returns {string}
 */
function llmApiUrl(baseUrl, relativePath) {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, root).href;
}

/**
 * @param {string} url Absolute URL.
 * @param {object} [init] fetch init.
 * @returns {Promise<{ ok: boolean, status: number, body: object|string }>}
 */
async function llmRequest(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string | null} apiKey Token.
 * @param {boolean} [jsonBody] JSON POST.
 * @returns {Record<string, string>}
 */
function buildHeaders(apiKey, jsonBody = false) {
  const headers = { accept: 'application/json' };
  if (jsonBody) {
    headers['content-type'] = 'application/json';
  }
  if (typeof apiKey === 'string' && apiKey !== '') {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * @param {string} baseUrl Root.
 * @param {string} model Model id.
 * @param {string} reason Failure.
 * @returns {string}
 */
function missingLlmMessage(baseUrl, model, reason) {
  return `${reason}

The OpenAI-compatible host was not ready at ${baseUrl} (model ${model}).

1. Start a server that implements GET /models and POST /chat/completions.
2. curl -sS "${baseUrl}/models"
3. npm run measure-llm-host -- --base-url ${baseUrl} --model ${model}

See docs/evaluation/README.md.
`;
}

/**
 * @param {string} baseUrl Root.
 * @param {string} model Model id.
 * @param {string | null} apiKey Token.
 * @returns {Promise<{ artifactId: string }>}
 */
async function loadArtifact(baseUrl, model, apiKey) {
  let listed;
  try {
    listed = await llmRequest(llmApiUrl(baseUrl, 'models'), { headers: buildHeaders(apiKey) });
  } catch (error) {
    throw new Error(missingLlmMessage(baseUrl, model, error.message));
  }
  if (!listed.ok) {
    throw new Error(missingLlmMessage(baseUrl, model, `GET /models returned HTTP ${listed.status}`));
  }
  const models = Array.isArray(listed.body?.data) ? listed.body.data : [];
  if (!models.find((entry) => entry.id === model)) {
    throw new Error(missingLlmMessage(baseUrl, model, `Model ${model} is not in GET /models.`));
  }
  return { artifactId: model };
}

/**
 * @param {number} tokenTarget Target tokens.
 * @returns {string}
 */
function buildFiller(tokenTarget) {
  const neededChars = Math.max(0, Math.floor(tokenTarget * FILLER_CHARS_PER_TOKEN));
  if (neededChars === 0) {
    return 'Say ready.';
  }
  const repeats = Math.ceil(neededChars / FILLER_UNIT.length);
  return `${FILLER_UNIT.repeat(repeats).slice(0, neededChars)}\nReply with the single word ready.`;
}

/**
 * @param {object} args Request fields.
 * @returns {Promise<object>}
 */
async function generate(args) {
  const { baseUrl, model, apiKey, messages, maxTokens } = args;
  const started = Date.now();
  try {
    const result = await llmRequest(llmApiUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: buildHeaders(apiKey, true),
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });
    const body = result.body && typeof result.body === 'object' ? result.body : {};
    const errorText =
      typeof body.error === 'string'
        ? body.error
        : body.error?.message
          ? String(body.error.message)
          : result.ok
            ? null
            : `HTTP ${result.status}`;
    const usage = body.usage && typeof body.usage === 'object' ? body.usage : {};
    return {
      ok: result.ok && !errorText,
      oom: Boolean(errorText && /out of memory|oom|unable to allocate|cuda|context length/i.test(errorText)),
      error: errorText,
      elapsedMs: Date.now() - started,
      promptTokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
      completionTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
    };
  } catch (error) {
    const message = error.name === 'AbortError' ? `request timed out after ${REQUEST_TIMEOUT_MS}ms` : error.message;
    return {
      ok: false,
      oom: /out of memory|oom|cuda/i.test(message),
      error: message,
      elapsedMs: Date.now() - started,
      promptTokens: null,
      completionTokens: null,
    };
  }
}

/**
 * @param {object} args Connection + windows.
 * @returns {Promise<object>}
 */
async function measureContext(args) {
  const steps = [];
  for (const windowTokens of args.windows) {
    const tokenTarget = Math.max(32, Math.floor(windowTokens * LADDER_FILL_RATIO));
    process.stdout.write(`  context ladder window=${windowTokens}…\n`);
    const step = await generate({
      baseUrl: args.baseUrl,
      model: args.model,
      apiKey: args.apiKey,
      messages: [{ role: 'user', content: buildFiller(tokenTarget) }],
      maxTokens: LADDER_MAX_TOKENS,
    });
    steps.push({ windowTokens, ...step });
    if (!step.ok) {
      break;
    }
  }
  const passing = steps.filter((step) => step.ok);
  const validatedContextCapacity = passing.at(-1)?.windowTokens ?? null;

  process.stdout.write('  reserved-output DRAFT-like generate…\n');
  const reservedOutput = await generate({
    baseUrl: args.baseUrl,
    model: args.model,
    apiKey: args.apiKey,
    messages: [
      {
        role: 'user',
        content:
          'Write a short grounded answer (4–8 sentences) explaining why refresh tokens stay in an httpOnly cookie. Do not invent APIs.',
      },
    ],
    maxTokens: RESERVED_OUTPUT_MAX_TOKENS,
  });
  const reservedOutputTokens =
    reservedOutput.ok && reservedOutput.completionTokens != null
      ? reservedOutput.completionTokens + RESERVED_OUTPUT_MARGIN_TOKENS
      : null;

  process.stdout.write('  parity fixtures…\n');
  const parity = {};
  for (const [name, content] of Object.entries(PARITY_FIXTURES)) {
    parity[name] = await generate({
      baseUrl: args.baseUrl,
      model: args.model,
      apiKey: args.apiKey,
      messages: [{ role: 'user', content }],
      maxTokens: 1,
    });
  }

  process.stdout.write('  excerpt-floor stub…\n');
  const excerptFloor = await generate({
    baseUrl: args.baseUrl,
    model: args.model,
    apiKey: args.apiKey,
    messages: [{ role: 'user', content: EXCERPT_STUB }],
    maxTokens: 1,
  });
  const excerptMinTokens =
    excerptFloor.ok && excerptFloor.promptTokens != null ? excerptFloor.promptTokens : null;

  return {
    steps,
    reservedOutput,
    parity,
    excerptFloor,
    recommendations: {
      validatedContextCapacity,
      reservedOutputTokens,
      excerptMinTokens,
    },
  };
}

/**
 * @param {object} args Connection + levels.
 * @returns {Promise<object>}
 */
async function measureQueue(args) {
  const levels = [];
  let recommendedMaxConcurrency = 0;
  for (const concurrency of args.queueLevels) {
    process.stdout.write(`  queue concurrency=${concurrency}…\n`);
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        generate({
          baseUrl: args.baseUrl,
          model: args.model,
          apiKey: args.apiKey,
          messages: [{ role: 'user', content: 'Reply with the single word ready.' }],
          maxTokens: QUEUE_MAX_TOKENS,
        }),
      ),
    );
    const failures = results.filter((entry) => !entry.ok);
    const level = {
      concurrency,
      ok: failures.length === 0,
      successCount: results.length - failures.length,
      failureCount: failures.length,
      wallMs: Date.now() - started,
      errors: failures.map((entry) => entry.error),
    };
    levels.push(level);
    if (!level.ok) {
      break;
    }
    recommendedMaxConcurrency = concurrency;
  }
  return { levels, recommendedMaxConcurrency };
}

/**
 * @param {object} args Connection + iterations + capacity.
 * @returns {Promise<object>}
 */
async function measureRunBudgets(args) {
  const iterations = [];
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let wallMs = 0;
  let stoppedReason = null;
  for (let index = 1; index <= args.runIterations; index += 1) {
    process.stdout.write(`  run-budget soak iteration=${index}…\n`);
    const entry = await generate({
      baseUrl: args.baseUrl,
      model: args.model,
      apiKey: args.apiKey,
      messages: [
        {
          role: 'system',
          content:
            'Choose one tool or finish retrieval. Return JSON with action call_tool or finish_retrieval. No chain-of-thought.',
        },
        {
          role: 'user',
          content: `Reply with JSON only: {"action":"finish_retrieval"}. Iteration ${index}.`,
        },
      ],
      maxTokens: TOOL_CHOICE_MAX_TOKENS,
    });
    iterations.push({ index, ...entry });
    wallMs += entry.elapsedMs;
    if (!entry.ok) {
      stoppedReason = entry.oom ? 'oom' : entry.error ?? 'request_failed';
      break;
    }
    if (Number.isFinite(entry.promptTokens)) {
      cumulativeInputTokens += entry.promptTokens;
    }
    if (Number.isFinite(entry.completionTokens)) {
      cumulativeOutputTokens += entry.completionTokens;
    }
  }
  const successCount = iterations.filter((entry) => entry.ok).length;
  const capacity = args.validatedContextCapacity ?? DEFAULT_WINDOWS[DEFAULT_WINDOWS.length - 1];
  const draftReserveTokens = Math.floor(capacity * DRAFT_RESERVE_FRACTION);
  const approxBytesForTools = Math.max(0, (capacity - draftReserveTokens) * 4);
  let cumulativeBytes = 0;
  let lastFit = FIXTURE_EXCERPT_BYTE_SIZES[0];
  for (const size of FIXTURE_EXCERPT_BYTE_SIZES) {
    cumulativeBytes += size;
    if (cumulativeBytes <= approxBytesForTools) {
      lastFit = cumulativeBytes;
    }
  }
  return {
    iterations,
    successCount,
    cumulativeInputTokens,
    cumulativeOutputTokens,
    wallMs,
    stoppedReason,
    recommendations: {
      maxCumulativeInputTokens:
        cumulativeInputTokens > 0 ? Math.floor(cumulativeInputTokens * HEADROOM_FACTOR) : null,
      maxCumulativeOutputTokens:
        cumulativeOutputTokens > 0 ? Math.floor(cumulativeOutputTokens * HEADROOM_FACTOR) : null,
      maxCumulativeToolResultBytes: Math.floor(lastFit * HEADROOM_FACTOR),
      maxTotalCalls: Math.max(2, Math.floor(successCount * 2 * HEADROOM_FACTOR)),
      maxWallTimeMs: wallMs > 0 ? Math.floor(wallMs * HEADROOM_FACTOR) : null,
    },
  };
}

/**
 * @param {object} report Full report.
 * @returns {void}
 */
function printConsoleRecommendations(report) {
  const ctx = report.context?.recommendations ?? {};
  const queue = report.queue ?? {};
  const run = report.runBudgets?.recommendations ?? {};
  const lines = [
    '',
    '========== Recommended values (copy into backend/.env and backend/.env.example) ==========',
    `LLM_BASE_URL=${report.baseUrl}`,
    `LLM_MODEL_ID=${report.model}`,
    `LLM_CONTEXT_CAPACITY=${ctx.validatedContextCapacity ?? '<no passing window — re-run>'}`,
    `LLM_QUEUE_MAX_CONCURRENCY=${queue.recommendedMaxConcurrency ?? 1}`,
    `LLM_RUN_MAX_CUMULATIVE_INPUT_TOKENS=${run.maxCumulativeInputTokens ?? '<re-run soak>'}`,
    `LLM_RUN_MAX_CUMULATIVE_OUTPUT_TOKENS=${run.maxCumulativeOutputTokens ?? '<re-run soak>'}`,
    `LLM_RUN_MAX_CUMULATIVE_TOOL_RESULT_BYTES=${run.maxCumulativeToolResultBytes ?? '<re-run soak>'}`,
    `LLM_RUN_MAX_TOTAL_CALLS=${run.maxTotalCalls ?? '<re-run soak>'}`,
    `LLM_RUN_MAX_WALL_TIME_MS=${run.maxWallTimeMs ?? '<re-run soak>'}`,
    '',
    '========== Named constants (update contextBudgeter.js after review) ==========',
    `RESERVED_OUTPUT_TOKENS=${ctx.reservedOutputTokens ?? '<re-run>'}`,
    `EXCERPT_MIN_TOKENS=${ctx.excerptMinTokens ?? '<re-run>'}`,
    '',
    'Re-run this script when the host, RAM/GPU, or model id changes.',
    '================================================================================',
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

/**
 * @param {object} report Full report.
 * @returns {string}
 */
function renderMarkdown(report) {
  const ctx = report.context?.recommendations ?? {};
  const run = report.runBudgets?.recommendations ?? {};
  return `# LLM host measurement (latest run)

Recorded: ${report.recordedAt}
Host: ${report.hostname} (${report.platform} ${report.arch})
Artifact: \`${report.model}\`

## Recommended env

| Key | Value |
|---|---|
| LLM_CONTEXT_CAPACITY | ${ctx.validatedContextCapacity ?? '—'} |
| LLM_QUEUE_MAX_CONCURRENCY | ${report.queue?.recommendedMaxConcurrency ?? '—'} |
| LLM_RUN_MAX_CUMULATIVE_INPUT_TOKENS | ${run.maxCumulativeInputTokens ?? '—'} |
| LLM_RUN_MAX_CUMULATIVE_OUTPUT_TOKENS | ${run.maxCumulativeOutputTokens ?? '—'} |
| LLM_RUN_MAX_CUMULATIVE_TOOL_RESULT_BYTES | ${run.maxCumulativeToolResultBytes ?? '—'} |
| LLM_RUN_MAX_TOTAL_CALLS | ${run.maxTotalCalls ?? '—'} |
| LLM_RUN_MAX_WALL_TIME_MS | ${run.maxWallTimeMs ?? '—'} |

## Constants (contextBudgeter.js)

| Constant | Value |
|---|---|
| RESERVED_OUTPUT_TOKENS | ${ctx.reservedOutputTokens ?? '—'} |
| EXCERPT_MIN_TOKENS | ${ctx.excerptMinTokens ?? '—'} |

Promote by editing \`backend/.env\` / \`.env.example\` (and constants above). This script never edits them.
`;
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  process.stdout.write(`Measuring LLM host ${options.baseUrl} model=${options.model}\n`);
  await loadArtifact(options.baseUrl, options.model, options.apiKey);

  /** @type {object} */
  const report = {
    recordedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    hostMemoryBytes: os.totalmem(),
    baseUrl: options.baseUrl,
    model: options.model,
    context: null,
    queue: null,
    runBudgets: null,
  };

  if (!options.skipContext) {
    process.stdout.write('=== Context capacity ===\n');
    report.context = await measureContext(options);
  }

  if (!options.skipQueue) {
    process.stdout.write('=== Inference queue concurrency ===\n');
    report.queue = await measureQueue(options);
  }

  if (!options.skipRunBudgets) {
    process.stdout.write('=== Chat run budgets ===\n');
    report.runBudgets = await measureRunBudgets({
      ...options,
      validatedContextCapacity: report.context?.recommendations?.validatedContextCapacity ?? null,
    });
  }

  await writeFile(path.join(options.outDir, 'llm-host.raw.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(options.outDir, 'llm-host.md'), renderMarkdown(report));
  process.stdout.write(`Wrote ${path.join(options.outDir, 'llm-host.md')}\n`);
  process.stdout.write(`Wrote ${path.join(options.outDir, 'llm-host.raw.json')}\n`);
  printConsoleRecommendations(report);

  const capacityOk = options.skipContext || report.context?.recommendations?.validatedContextCapacity != null;
  const queueOk = options.skipQueue || (report.queue?.recommendedMaxConcurrency ?? 0) > 0;
  const runOk =
    options.skipRunBudgets || (report.runBudgets?.successCount ?? 0) > 0;
  if (!capacityOk || !queueOk || !runOk) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
