/**
 * Reusable OpenAI-compatible context-capacity and tokenizer-parity measurement
 * (Phase 43). Re-run on each host after artifact, provider, or RAM changes.
 *
 * Usage (repo root):
 *   npm run measure-llm-context
 *   npm run measure-llm-context -- --base-url http://127.0.0.1:11434/v1 --model qwen3.8:latest
 *   node scripts/measure-llm-context.mjs --parity-only
 *
 * See docs/evaluation/README.md for the full runbook. This script does not npm-install
 * tokenizers and does not write backend named constants.
 */
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default OpenAI-compatible root (typically ends in /v1). */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

/** Default chat model id; the report pins this id as the artifact id. */
const DEFAULT_MODEL = 'qwen3.8:latest';

/** Default prompt-size targets from solution §1.1. */
const DEFAULT_WINDOWS = Object.freeze([32768, 65536, 131072]);

/** Chars per estimated token when building filler (English repeating prose). */
const FILLER_CHARS_PER_TOKEN = 4;

/** Share of each window filled with prompt text. */
const LADDER_FILL_RATIO = 0.25;

/** Tokens to generate on each ladder step (keeps the step a generate, not a soak). */
const LADDER_MAX_TOKENS = 8;

/** Max generated tokens for the reserved-output DRAFT-like call. */
const RESERVED_OUTPUT_MAX_TOKENS = 1024;

/** Tokens added on top of measured DRAFT completion_tokens when recommending a reserve. */
const RESERVED_OUTPUT_MARGIN_TOKENS = 256;

/** Per-request timeout; large prompts + first load can take several minutes. */
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

/** Repeating unit used to grow ladder prompts without inventing product text. */
const FILLER_UNIT =
  'The authentication middleware validates JWT claims before the handler runs.\n';

/** Minimum source-id stub used to estimate EXCERPT_MIN_TOKENS. */
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
 * Prints CLI help and the runbook pointer.
 * @returns {void}
 */
function printHelp() {
  process.stdout.write(`Reusable Phase 43 context measurement (OpenAI-compatible /v1).

Usage:
  npm run measure-llm-context -- [options]
  node scripts/measure-llm-context.mjs [options]

Options:
  --base-url <url>   OpenAI-compatible root (default ${DEFAULT_BASE_URL})
  --model <name>     Model id listed by GET /models (default ${DEFAULT_MODEL})
  --api-key <key>    Optional Bearer token (else LLM_API_KEY when set)
  --windows <list>   Comma-separated prompt-size targets (default ${DEFAULT_WINDOWS.join(',')})
  --out-dir <dir>    Output directory (default docs/evaluation)
  --skip-ladder      Skip the 32K/64K/128K generate ladder
  --parity-only      Pin artifact + parity fixtures only
  --help             Show this help

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
    windows: [...DEFAULT_WINDOWS],
    outDir: path.join(repoRoot, 'docs/evaluation'),
    skipLadder: false,
    parityOnly: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else if (flag === '--skip-ladder') {
      options.skipLadder = true;
    } else if (flag === '--parity-only') {
      options.parityOnly = true;
    } else if (flag === '--base-url' && next) {
      options.baseUrl = next.replace(/\/$/, '');
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
 * JSON POST/GET against the OpenAI-compatible host with a hard timeout.
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
 * Request headers. Bearer is sent only when an API key is configured.
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
 * Fail-closed operator message when the provider is unreachable or the model is missing.
 * @param {string} baseUrl OpenAI-compatible root.
 * @param {string} model Model id.
 * @param {string} reason What failed.
 * @returns {string}
 */
function missingLlmMessage(baseUrl, model, reason) {
  return `${reason}

The OpenAI-compatible host was not ready at ${baseUrl} (model ${model}).

1. Start a server that implements GET /models and POST /chat/completions.
2. Confirm the model id is listed:
   curl -sS "${baseUrl}/models"
3. npm run measure-llm-context -- --base-url ${baseUrl} --model ${model}

See docs/evaluation/README.md.
`;
}

/**
 * Builds repeating prose that aims at approximately tokenTarget tokens.
 * @param {number} tokenTarget Desired prompt tokens.
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
 * One non-streaming chat completion; records provider usage when present.
 * @param {object} args Request fields.
 * @returns {Promise<object>}
 */
async function generate(args) {
  const { baseUrl, model, apiKey, prompt, maxTokens } = args;
  const started = process.hrtime.bigint();
  const rssBefore = process.memoryUsage().rss;
  let result;
  try {
    result = await llmRequest(llmApiUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: buildHeaders(apiKey, true),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });
  } catch (error) {
    const message = error.name === 'AbortError' ? `request timed out after ${REQUEST_TIMEOUT_MS}ms` : error.message;
    return {
      ok: false,
      oom: /out of memory|oom|cuda/i.test(message),
      error: message,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
      nodeRssBeforeBytes: rssBefore,
      nodeRssAfterBytes: process.memoryUsage().rss,
    };
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const body = result.body && typeof result.body === 'object' ? result.body : { error: String(result.body) };
  const errorText =
    typeof body.error === 'string'
      ? body.error
      : body.error?.message
        ? String(body.error.message)
        : result.ok
          ? null
          : `HTTP ${result.status}`;
  const oom = Boolean(errorText && /out of memory|oom|unable to allocate|context length|maximum context/i.test(errorText));
  const usage = body.usage && typeof body.usage === 'object' ? body.usage : {};
  return {
    ok: result.ok && !errorText,
    oom,
    error: errorText,
    elapsedMs: Math.round(elapsedMs),
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    nodeRssBeforeBytes: rssBefore,
    nodeRssAfterBytes: process.memoryUsage().rss,
  };
}

/**
 * Confirms GET /models lists the configured model id.
 * @param {string} baseUrl OpenAI-compatible root.
 * @param {string} model Model id.
 * @param {string | null} apiKey Optional Bearer token.
 * @returns {Promise<object>}
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
  return {
    artifactId: model,
    ownedBy: typeof match.owned_by === 'string' ? match.owned_by : null,
    created: match.created ?? null,
    usesLatestTag: /:latest$/.test(model) || model === 'latest',
  };
}

/**
 * Host + process fingerprint so two environments are not compared as one.
 * @param {object} extra Extra fields.
 * @returns {object}
 */
function buildFingerprint(extra) {
  return {
    recordedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    hostMemoryBytes: os.totalmem(),
    hostFreeMemoryBytes: os.freemem(),
    cpuCount: os.cpus()?.length ?? null,
    command: process.argv.slice(2).join(' '),
    ...extra,
  };
}

/**
 * Walks the prompt-size ladder and stops on the first failure or OOM.
 * @param {object} args Ladder args.
 * @returns {Promise<object[]>}
 */
async function runLadder(args) {
  const { baseUrl, model, apiKey, windows } = args;
  const steps = [];
  for (const windowTokens of windows) {
    const tokenTarget = Math.max(32, Math.floor(windowTokens * LADDER_FILL_RATIO));
    process.stdout.write(`ladder window=${windowTokens} fill≈${tokenTarget} tokens…\n`);
    const step = await generate({
      baseUrl,
      model,
      apiKey,
      prompt: buildFiller(tokenTarget),
      maxTokens: LADDER_MAX_TOKENS,
    });
    steps.push({
      windowTokens,
      fillRatio: LADDER_FILL_RATIO,
      targetPromptTokens: tokenTarget,
      ...step,
    });
    if (!step.ok) {
      break;
    }
  }
  return steps;
}

/**
 * Renders the human latest-run note. Prior runs live in git history only.
 * @param {object} report Full JSON report.
 * @returns {string}
 */
function renderMarkdown(report) {
  const { fingerprint, artifact, ladder, reservedOutput, parity, excerptFloor, recommendations } = report;
  const latestWarning = artifact.usesLatestTag
    ? 'The requested id ends in `:latest`. Treat the model id below as the artifact id — re-measure if the host retags it.\n'
    : '';
  const ladderRows = (ladder?.steps ?? [])
    .map((step) => {
      const status = step.ok ? 'pass' : step.oom ? 'oom' : 'fail';
      return `| ${step.windowTokens} | ${status} | ${step.promptTokens ?? '—'} | ${step.completionTokens ?? '—'} | ${step.elapsedMs} | ${step.error ?? ''} |`;
    })
    .join('\n');
  const parityRows = Object.entries(parity?.fixtures ?? {})
    .map(([name, row]) => `| ${name} | ${row.promptTokens ?? '—'} | ${row.ok ? 'yes' : 'no'} |`)
    .join('\n');
  return `# Phase 43 — Context measurement (latest run)

This file is **overwritten** on every script run. Older numbers are in git history.
Re-run on every machine (and after artifact / provider / RAM changes). Runbook:
[docs/evaluation/README.md](./README.md).

Recorded **${fingerprint.recordedAt}** on \`${fingerprint.hostname}\` (${fingerprint.platform} ${fingerprint.arch}, Node ${fingerprint.nodeVersion}).
Protocol: OpenAI-compatible \`/v1\`. Host memory ${fingerprint.hostMemoryBytes} bytes.

Command:

\`\`\`bash
npm run measure-llm-context -- ${fingerprint.command}
\`\`\`

${latestWarning}
## Artifact

| Field | Value |
|---|---|
| Requested model | \`${artifact.requestedModel}\` |
| Artifact id | \`${artifact.artifactId}\` |
| owned_by | ${artifact.ownedBy ?? '—'} |
| created | ${artifact.created ?? '—'} |

Artifact id is the configured model id (GET /models exact match). It is not a GGUF digest.

## Capacity ladder

Fill ratio ${LADDER_FILL_RATIO} of each prompt-size target. The host uses its own context
window — this script does not send provider-specific context knobs.
Stopped at the first failure. Do not invent a larger window than the last pass.

| window | result | prompt_tokens | completion_tokens | elapsed_ms | error |
|---|---|---|---|---|---|
${ladderRows || '| — | skipped | — | — | — | |'}

**validatedContextCapacity:** ${recommendations.validatedContextCapacity ?? 'null (no passing window)'}

## Reserved output

DRAFT-like generate with \`max_tokens=${RESERVED_OUTPUT_MAX_TOKENS}\`, margin ${RESERVED_OUTPUT_MARGIN_TOKENS}.

| Field | Value |
|---|---|
| ok | ${reservedOutput?.ok ?? 'skipped'} |
| completion_tokens | ${reservedOutput?.completionTokens ?? '—'} |
| recommended reservedOutputTokens | ${recommendations.reservedOutputTokens ?? '—'} |

## Parity fixtures

Provider \`usage.prompt_tokens\` for fixed texts. A later Node tokenizer must match these
counts within the tolerance recorded when that package is chosen.

| fixture | prompt_tokens | ok |
|---|---|---|
${parityRows || '| — | — | skipped |'}

## Excerpt floor

Stub \`${EXCERPT_STUB}\` → prompt_tokens **${excerptFloor?.promptTokens ?? '—'}**.
Recommended \`EXCERPT_MIN_TOKENS\`: ${recommendations.excerptMinTokens ?? '—'}.

## Promote numbers

Do not copy another host’s cap. After reviewing this run, set \`LLM_CONTEXT_CAPACITY\`
in the API env. This script never edits application source.
`;
}

/**
 * Orchestrates pin → optional ladder → reserved output → parity → excerpt floor.
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const artifactMeta = await loadArtifact(options.baseUrl, options.model, options.apiKey);
  const fingerprint = buildFingerprint({
    baseUrlHost: (() => {
      try {
        return new URL(options.baseUrl).host;
      } catch {
        return '(unparseable)';
      }
    })(),
  });
  const artifact = {
    requestedModel: options.model,
    artifactId: artifactMeta.artifactId,
    ownedBy: artifactMeta.ownedBy,
    created: artifactMeta.created,
    usesLatestTag: artifactMeta.usesLatestTag,
  };

  const report = {
    fingerprint,
    artifact,
    ladder: { skipped: true, steps: [] },
    reservedOutput: null,
    parity: { skipped: true, fixtures: {} },
    excerptFloor: null,
    recommendations: {
      validatedContextCapacity: null,
      reservedOutputTokens: null,
      excerptMinTokens: null,
    },
  };

  if (!options.parityOnly && !options.skipLadder) {
    report.ladder.skipped = false;
    report.ladder.steps = await runLadder({
      baseUrl: options.baseUrl,
      model: options.model,
      apiKey: options.apiKey,
      windows: options.windows,
    });
    const passing = report.ladder.steps.filter((step) => step.ok);
    report.recommendations.validatedContextCapacity = passing.at(-1)?.windowTokens ?? null;
  }

  if (!options.parityOnly) {
    process.stdout.write('reserved-output DRAFT-like generate…\n');
    report.reservedOutput = await generate({
      baseUrl: options.baseUrl,
      model: options.model,
      apiKey: options.apiKey,
      prompt:
        'Write a short grounded answer (4–8 sentences) explaining why refresh tokens stay in an httpOnly cookie. Do not invent APIs.',
      maxTokens: RESERVED_OUTPUT_MAX_TOKENS,
    });
    if (report.reservedOutput.ok && report.reservedOutput.completionTokens != null) {
      report.recommendations.reservedOutputTokens =
        report.reservedOutput.completionTokens + RESERVED_OUTPUT_MARGIN_TOKENS;
    }
  }

  process.stdout.write('parity fixtures…\n');
  report.parity.skipped = false;
  for (const [name, content] of Object.entries(PARITY_FIXTURES)) {
    report.parity.fixtures[name] = await generate({
      baseUrl: options.baseUrl,
      model: options.model,
      apiKey: options.apiKey,
      prompt: content,
      maxTokens: 1,
    });
  }

  if (!options.parityOnly) {
    process.stdout.write('excerpt-floor stub…\n');
    report.excerptFloor = await generate({
      baseUrl: options.baseUrl,
      model: options.model,
      apiKey: options.apiKey,
      prompt: EXCERPT_STUB,
      maxTokens: 1,
    });
    if (report.excerptFloor.ok && report.excerptFloor.promptTokens != null) {
      report.recommendations.excerptMinTokens = report.excerptFloor.promptTokens;
    }
  }

  await writeFile(
    path.join(options.outDir, 'phase-43-context.raw.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(path.join(options.outDir, 'phase-43-context.md'), renderMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify(report.recommendations, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
