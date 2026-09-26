/**
 * Optional concurrency ladder for the OpenAI-compatible host (Phase 45).
 * Records how many short chat completions succeed in parallel. Does not edit
 * INFERENCE_QUEUE_MAX_* in the application.
 *
 * Usage (repo root):
 *   npm run measure-llm-queue
 *   npm run measure-llm-queue -- --base-url http://127.0.0.1:11434/v1 --model qwen3.8:latest
 *
 * See docs/evaluation/README.md.
 */
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default OpenAI-compatible root. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

/** Default chat model id. */
const DEFAULT_MODEL = 'qwen3.8:latest';

/** Concurrency steps. Stop the ladder on the first 5xx / OOM-class failure. */
const DEFAULT_LEVELS = Object.freeze([1, 2, 4]);

/** Short completion so the ladder measures overlap, not a long draft. */
const MAX_TOKENS = 8;

/** Per-request timeout. */
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Prints CLI help.
 * @returns {void}
 */
function printHelp() {
  process.stdout.write(`Phase 45 inference-queue measurement (OpenAI-compatible /v1).

Usage:
  npm run measure-llm-queue -- [options]
  node scripts/measure-llm-queue.mjs [options]

Options:
  --base-url <url>   OpenAI-compatible root (default ${DEFAULT_BASE_URL})
  --model <name>     Model id listed by GET /models (default ${DEFAULT_MODEL})
  --api-key <key>    Optional Bearer token (else LLM_API_KEY when set)
  --levels <list>    Comma-separated concurrency steps (default ${DEFAULT_LEVELS.join(',')})
  --out-dir <dir>    Output directory (default docs/evaluation)
  --help             Show this help

This script never writes backend named constants. Review the report before
raising INFERENCE_QUEUE_MAX_CONCURRENCY above 1.

Runbook: docs/evaluation/README.md
`);
}

/**
 * Parses argv into a frozen options object.
 * @param {string[]} argv Process arguments after the script path.
 * @returns {object}
 */
function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    apiKey: null,
    levels: [...DEFAULT_LEVELS],
    outDir: path.join(repoRoot, 'docs/evaluation'),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else if (flag === '--base-url' && next) {
      options.baseUrl = next.replace(/\/$/, '') || next;
      index += 1;
    } else if (flag === '--model' && next) {
      options.model = next;
      index += 1;
    } else if (flag === '--api-key' && next) {
      options.apiKey = next;
      index += 1;
    } else if (flag === '--levels' && next) {
      options.levels = next
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((n) => n > 0);
      index += 1;
    } else if (flag === '--out-dir' && next) {
      options.outDir = path.isAbsolute(next) ? next : path.resolve(repoRoot, next);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete flag: ${flag}. See --help.`);
    }
  }
  if (options.levels.length === 0) {
    throw new Error('--levels must list at least one positive integer.');
  }
  if (!options.apiKey) {
    const fromEnv = typeof process.env.LLM_API_KEY === 'string' ? process.env.LLM_API_KEY.trim() : '';
    options.apiKey = fromEnv === '' ? null : fromEnv;
  }
  return Object.freeze(options);
}

/**
 * Joins a relative path onto the OpenAI-compatible root without dropping `/v1`.
 * @param {string} baseUrl Configured root.
 * @param {string} relativePath Path such as `models`.
 * @returns {string}
 */
function llmApiUrl(baseUrl, relativePath) {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, root).href;
}

/**
 * JSON GET/POST with a hard timeout.
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
 * @param {string | null} apiKey Optional token.
 * @param {boolean} [jsonBody] Whether this is a JSON POST.
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
 * @param {string} baseUrl OpenAI-compatible root.
 * @param {string} model Model id.
 * @param {string} reason What failed.
 * @returns {string}
 */
function missingLlmMessage(baseUrl, model, reason) {
  return `${reason}

The OpenAI-compatible host was not ready at ${baseUrl} (model ${model}).

1. Start a server that implements GET /models and POST /chat/completions.
2. curl -sS "${baseUrl}/models"
3. npm run measure-llm-queue -- --base-url ${baseUrl} --model ${model}

See docs/evaluation/README.md.
`;
}

/**
 * Confirms GET /models lists the configured model id.
 * @param {string} baseUrl OpenAI-compatible root.
 * @param {string} model Model id.
 * @param {string | null} apiKey Optional Bearer token.
 * @returns {Promise<{ artifactId: string }>}
 */
async function loadArtifact(baseUrl, model, apiKey) {
  let listed;
  try {
    listed = await llmRequest(llmApiUrl(baseUrl, 'models'), {
      headers: buildHeaders(apiKey),
    });
  } catch (error) {
    throw new Error(missingLlmMessage(baseUrl, model, error.message));
  }
  if (!listed.ok) {
    throw new Error(missingLlmMessage(baseUrl, model, `GET /models returned HTTP ${listed.status}`));
  }
  const models = Array.isArray(listed.body?.data) ? listed.body.data : [];
  const match = models.find((entry) => entry.id === model);
  if (!match) {
    throw new Error(missingLlmMessage(baseUrl, model, `Model ${model} is not in GET /models.`));
  }
  return { artifactId: model };
}

/**
 * One short non-streaming completion.
 * @param {object} args Connection + prompt fields.
 * @returns {Promise<object>}
 */
async function generateOnce(args) {
  const { baseUrl, model, apiKey } = args;
  const started = Date.now();
  try {
    const result = await llmRequest(llmApiUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: buildHeaders(apiKey, true),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word ready.' }],
        stream: false,
        temperature: 0,
        max_tokens: MAX_TOKENS,
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
    const oom = Boolean(errorText && /out of memory|oom|unable to allocate|cuda/i.test(errorText));
    return {
      ok: result.ok && !errorText,
      status: result.status,
      oom,
      error: errorText,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const message = error.name === 'AbortError' ? `request timed out after ${REQUEST_TIMEOUT_MS}ms` : error.message;
    return {
      ok: false,
      status: 0,
      oom: /out of memory|oom|cuda/i.test(message),
      error: message,
      elapsedMs: Date.now() - started,
    };
  }
}

/**
 * Runs `concurrency` completions at once.
 * @param {object} args Connection fields plus concurrency.
 * @returns {Promise<object>}
 */
async function runLevel(args) {
  const { concurrency } = args;
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => generateOnce(args)),
  );
  const failures = results.filter((entry) => !entry.ok);
  const elapsedMs = results.map((entry) => entry.elapsedMs);
  return {
    concurrency,
    ok: failures.length === 0,
    successCount: results.length - failures.length,
    failureCount: failures.length,
    wallMs: Date.now() - started,
    maxElapsedMs: Math.max(...elapsedMs),
    errors: failures.map((entry) => entry.error),
    oom: results.some((entry) => entry.oom),
    results,
  };
}

/**
 * @param {object} report Raw measurement object.
 * @returns {string}
 */
function renderMarkdown(report) {
  const lines = [
    '# Phase 45 — inference queue measurement',
    '',
    `Recorded: ${report.recordedAt}`,
    `Host: ${report.hostname} (${report.platform} ${report.arch})`,
    `Artifact id: \`${report.artifactId}\``,
    '',
    'The application does **not** read this file. Production stays at',
    '`INFERENCE_QUEUE_MAX_CONCURRENCY = 1` until a reviewed run is promoted.',
    '',
    '| Concurrency | OK | Success | Fail | Wall ms | Max request ms |',
    '|---|---|---|---|---|---|',
  ];
  for (const level of report.levels) {
    lines.push(
      `| ${level.concurrency} | ${level.ok ? 'yes' : 'no'} | ${level.successCount} | ${level.failureCount} | ${level.wallMs} | ${level.maxElapsedMs} |`,
    );
  }
  lines.push('');
  lines.push(`Last fully successful concurrency: **${report.recommendedMaxConcurrency}**.`);
  lines.push('');
  lines.push('Do not raise the product constant without reviewing this host, RAM/GPU, and error column.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Script entry. Exits 1 when the host is down or every level fails.
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const artifact = await loadArtifact(options.baseUrl, options.model, options.apiKey);
  const levels = [];
  let recommendedMaxConcurrency = 0;
  for (const concurrency of options.levels) {
    const level = await runLevel({
      baseUrl: options.baseUrl,
      model: options.model,
      apiKey: options.apiKey,
      concurrency,
    });
    levels.push(level);
    if (!level.ok) {
      break;
    }
    recommendedMaxConcurrency = concurrency;
  }
  const report = {
    recordedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    hostMemoryBytes: os.totalmem(),
    artifactId: artifact.artifactId,
    baseUrlHost: new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`).host,
    levels,
    recommendedMaxConcurrency,
    notes: 'Does not write INFERENCE_QUEUE_MAX_CONCURRENCY or INFERENCE_QUEUE_MAX_DEPTH.',
  };
  const markdownPath = path.join(options.outDir, 'phase-45-queue.md');
  const rawPath = path.join(options.outDir, 'phase-45-queue.raw.json');
  await writeFile(markdownPath, renderMarkdown(report));
  await writeFile(rawPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Wrote ${markdownPath}\nWrote ${rawPath}\nLast fully successful concurrency: ${recommendedMaxConcurrency}\n`);
  if (recommendedMaxConcurrency === 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
