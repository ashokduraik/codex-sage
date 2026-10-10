/**
 * Conversation LLM client — one createOpenAI factory for the startup GET /models
 * probe, generateText, and streamText. Every generate/stream call is budgeted
 * then queued. No HTTP responses, no model pull.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { generateText as sdkGenerateText, Output, streamText as sdkStreamText } from 'ai';
import { loadConfig } from '../../platform/config.js';
import { ApiError } from '../../platform/errors.js';
import { prepareModelInput } from './contextBudgeter.js';

/** Fail the probe if the provider does not answer within this window. */
export const LLM_PROBE_TIMEOUT_MS = 10_000;

/**
 * One in-flight Chat Completions call per API worker until a reviewed
 * measure-llm-queue run is promoted. Always host-safe; not a capacity guess.
 */
export const INFERENCE_QUEUE_MAX_CONCURRENCY = 1;

/**
 * Waiting + running tasks allowed per API worker before LLM_QUEUE_FULL.
 * Backpressure, not a measured host limit.
 */
export const INFERENCE_QUEUE_MAX_DEPTH = 8;

const defaultLog = {
  info: (obj, msg) => console.info(JSON.stringify({ level: 'info', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

/** Default queue for the API process (per worker). Tests inject their own limits. */
let defaultInferenceQueue;

/** Cached queue on a reused `{ maxDepth, maxConcurrency }` object so concurrent calls share it. */
const QUEUE_INSTANCE = Symbol('inferenceQueue');

/**
 * Whether URL + model id are present (startup probe already attached artifactId).
 * @param {{ baseUrl?: string, modelId?: string }} [llm] Connection slice; defaults to loadConfig().
 * @returns {{ ready: boolean, modelId: string | null }}
 */
export function getLlmConfigStatus(llm) {
  const slice = llm ?? loadConfig().llm;
  const configured = readConfiguredLlm(slice);
  return { ready: Boolean(configured), modelId: configured?.modelId ?? null };
}

/**
 * Proves the OpenAI-compatible host is up and the configured model id is listed.
 * Uses the same createOpenAI factory as generate/stream; GET /models goes through
 * that factory's fetch + baseURL + auth. No generate, no pull.
 * @param {{ baseUrl: string, modelId: string, apiKey?: string | null }} llm Env-backed connection slice.
 * @param {{ info: Function, error: Function }} [log] Structured logger.
 * @param {{ fetch?: typeof fetch }} [options] Injected fetch (tests) or global fetch.
 * @returns {Promise<{ artifactId: string }>}
 * @throws {Error} When the host is down or the model id is missing from GET /models.
 */
export async function assertLlmAvailable(llm, log = defaultLog, options = {}) {
  let host;
  try {
    host = new URL(llm.baseUrl).host;
  } catch {
    host = '(unparseable)';
  }
  const modelId = llm.modelId;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const modelsRoot = llm.baseUrl.endsWith('/') ? llm.baseUrl : `${llm.baseUrl}/`;
  const headers = { accept: 'application/json' };
  if (typeof llm.apiKey === 'string' && llm.apiKey !== '') {
    headers.authorization = `Bearer ${llm.apiKey}`;
  }
  try {
    createLlmProvider(llm, { fetch: fetchFn });
    const response = await fetchFn(new URL('models', modelsRoot).href, {
      headers,
      signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new Error(`GET /models returned HTTP ${response.status}`);
    }
    const models = Array.isArray(body?.data) ? body.data : [];
    const match = models.find((entry) => entry.id === modelId);
    if (!match) {
      throw new Error('model is not in GET /models');
    }

    log.info({ host, modelId }, 'llm available');
    return { artifactId: modelId };
  } catch (error) {
    const errName = error instanceof Error ? error.name : 'Error';
    log.error({ host, modelId, errName }, 'llm probe failed');
    throw error;
  }
}

/**
 * Budgeted, queued Chat Completions generate. Does not write HTTP.
 * @param {{
 *   purpose: string,
 *   segments: object[],
 *   summarySegment?: object,
 *   toolSchemaTokenOverhead?: number,
 *   abortSignal?: AbortSignal,
 *   outputSchema?: object,
 * }} request Assembly for prepareModelInput plus optional abort/schema.
 * @param {{
 *   llm?: object,
 *   tokenizer?: object,
 *   fetch?: typeof fetch,
 *   generateTextImpl?: Function,
 *   queue?: { enqueue?: Function, maxDepth?: number, maxConcurrency?: number },
 * }} [options] Config + test seams.
 * @returns {Promise<{
 *   text: string,
 *   usage: object | null,
 *   durationMs: number,
 *   modelId: string,
 *   contextMetrics: object,
 * }>}
 * @throws When config, budget, queue, or the provider fails.
 */
export async function generateText(request, options = {}) {
  const prepared = preflightModelInput(request, options);
  const queue = resolveQueue(options.queue);
  try {
    const { text, usage, durationMs } = await queue.enqueue(async () => {
      const startedAt = Date.now();
      const result = await invokeSdkCall('generate', request, prepared, options);
      return {
        text: typeof result?.text === 'string' ? result.text : '',
        usage: mapUsage(result?.usage),
        durationMs: Date.now() - startedAt,
      };
    });
    return {
      text,
      usage,
      durationMs,
      modelId: options.llm.modelId,
      contextMetrics: contextMetricsFromPrepared(prepared),
    };
  } catch (error) {
    throwProviderError(error);
  }
}

/**
 * Budgeted, queued Chat Completions stream. Does not write HTTP or SSE.
 * @param {{
 *   purpose: string,
 *   segments: object[],
 *   summarySegment?: object,
 *   toolSchemaTokenOverhead?: number,
 *   abortSignal?: AbortSignal,
 *   outputSchema?: object,
 * }} request Assembly for prepareModelInput plus optional abort/schema.
 * @param {{
 *   llm?: object,
 *   tokenizer?: object,
 *   fetch?: typeof fetch,
 *   streamTextImpl?: Function,
 *   queue?: { enqueue?: Function, maxDepth?: number, maxConcurrency?: number },
 * }} [options] Config + test seams.
 * @returns {Promise<{
 *   textStream: AsyncIterable<string>,
 *   usage: Promise<object | null>,
 *   durationMs: Promise<number>,
 *   modelId: string,
 *   contextMetrics: object,
 * }>}
 * @throws When config, budget, queue, or starting the provider fails.
 */
export async function streamText(request, options = {}) {
  const prepared = preflightModelInput(request, options);
  const queue = resolveQueue(options.queue);
  let usageResolve;
  let durationResolve;
  const usagePromise = new Promise((resolve) => {
    usageResolve = resolve;
  });
  const durationPromise = new Promise((resolve) => {
    durationResolve = resolve;
  });

  let sdkResult;
  let startedAt;
  try {
    sdkResult = await queue.enqueue(async () => {
      startedAt = Date.now();
      return invokeSdkCall('stream', request, prepared, options);
    });
  } catch (error) {
    throwProviderError(error);
  }

  const textStream = (async function* consumeSdkStream() {
    let settled = false;
    /**
     * @param {unknown} [streamError] Set when the iterable throws.
     * @returns {Promise<void>}
     */
    async function settle(streamError) {
      if (settled) {
        return;
      }
      settled = true;
      durationResolve(Date.now() - startedAt);
      if (streamError) {
        usageResolve(null);
        return;
      }
      try {
        usageResolve(mapUsage(await (sdkResult.usage ?? null)));
      } catch {
        usageResolve(null);
      }
    }

    try {
      for await (const chunk of sdkResult.textStream) {
        yield chunk;
      }
      await settle();
    } catch (error) {
      await settle(error);
      throw error;
    }
  })();

  return {
    textStream,
    usage: usagePromise,
    durationMs: durationPromise,
    modelId: options.llm.modelId,
    contextMetrics: contextMetricsFromPrepared(prepared),
  };
}

/**
 * Shared OpenAI-compatible provider. generate/stream use `provider.chat` (not Responses).
 * @param {{ baseUrl: string, apiKey?: string | null }} llm Env-backed connection slice.
 * @param {{ fetch?: typeof fetch }} [options] Injected fetch for tests.
 * @returns {ReturnType<typeof createOpenAI>}
 */
function createLlmProvider(llm, options = {}) {
  return createOpenAI({
    baseURL: llm.baseUrl,
    apiKey: llm.apiKey || 'not-needed',
    fetch: options.fetch,
  });
}

/**
 * Uses an injected queue, a limits object, or the process default.
 * @param {{ enqueue?: Function, maxDepth?: number, maxConcurrency?: number } | undefined} queueOption Test seam.
 * @returns {{ enqueue: (task: () => Promise<unknown>) => Promise<unknown> }}
 */
function resolveQueue(queueOption) {
  if (queueOption && typeof queueOption.enqueue === 'function') {
    return queueOption;
  }
  if (queueOption && (queueOption.maxDepth != null || queueOption.maxConcurrency != null)) {
    queueOption[QUEUE_INSTANCE] ??= createInferenceQueue(queueOption);
    return queueOption[QUEUE_INSTANCE];
  }
  defaultInferenceQueue ??= createInferenceQueue();
  return defaultInferenceQueue;

  /**
   * FIFO queue with a concurrency cap. Rejects before enqueue when full.
   * Drain runs as a method on the returned object (not a nested function declaration).
   * @param {{ maxDepth?: number, maxConcurrency?: number }} [limits] Production constants or a test override.
   * @returns {{ enqueue: (task: () => Promise<unknown>) => Promise<unknown> }}
   */
  function createInferenceQueue(limits = {}) {
    const maxDepth = limits.maxDepth ?? INFERENCE_QUEUE_MAX_DEPTH;
    const maxConcurrency = limits.maxConcurrency ?? INFERENCE_QUEUE_MAX_CONCURRENCY;
    let running = 0;
    const waiting = [];

    const queue = {
      /**
       * @param {() => Promise<unknown>} task Work that talks to the SDK.
       * @returns {Promise<unknown>}
       */
      enqueue(task) {
        if (waiting.length + running >= maxDepth) {
          return Promise.reject(ApiError.fromCode('LLM_QUEUE_FULL'));
        }
        return new Promise((resolve, reject) => {
          waiting.push({ task, resolve, reject });
          queue.drain();
        });
      },
      /** Starts queued work while a concurrency slot is free. */
      drain() {
        while (running < maxConcurrency && waiting.length > 0) {
          const item = waiting.shift();
          running += 1;
          Promise.resolve()
            .then(() => item.task())
            .then(item.resolve, item.reject)
            .finally(() => {
              running -= 1;
              queue.drain();
            });
        }
      },
    };
    return { enqueue: (task) => queue.enqueue(task) };
  }
}

/**
 * @param {{ baseUrl?: string, modelId?: string } | undefined} llm Connection slice.
 * @returns {{ baseUrl: string, modelId: string } | null}
 */
function readConfiguredLlm(llm) {
  const baseUrl = typeof llm?.baseUrl === 'string' ? llm.baseUrl.trim() : '';
  const modelId = typeof llm?.modelId === 'string' ? llm.modelId.trim() : '';
  if (!baseUrl || !modelId) {
    return null;
  }
  return { baseUrl, modelId };
}

/**
 * Maps provider usage. Returns null when no counts were reported — never invents totals.
 * @param {object | null | undefined} usage SDK usage object.
 * @returns {{ inputTokens: number | null, outputTokens: number | null, totalTokens: number | null } | null}
 */
function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const hasInput = Number.isFinite(usage.inputTokens);
  const hasOutput = Number.isFinite(usage.outputTokens);
  const hasTotal = Number.isFinite(usage.totalTokens);
  if (!hasInput && !hasOutput && !hasTotal) {
    return null;
  }
  return {
    inputTokens: hasInput ? usage.inputTokens : null,
    outputTokens: hasOutput ? usage.outputTokens : null,
    totalTokens: hasTotal ? usage.totalTokens : null,
  };
}

/**
 * Persistable budgeter fields for Phase 49. Only values prepareModelInput actually measured.
 * @param {object} prepared Phase 43 return value.
 * @returns {object}
 */
function contextMetricsFromPrepared(prepared) {
  return {
    measuredInputTokens: prepared.measuredInputTokens,
    maximumInputBudget: prepared.maximumInputBudget,
    reservedOutputTokens: prepared.reservedOutputTokens,
    validatedContextCapacity: prepared.validatedContextCapacity,
    compactionActions: prepared.compactionActions,
  };
}

/**
 * @param {unknown} error Thrown value.
 * @returns {never}
 */
function throwProviderError(error) {
  if (error instanceof ApiError) {
    throw error;
  }
  throw ApiError.fromCode('LLM_PROVIDER_ERROR');
}

/**
 * Chat Completions via injected impl or provider.chat. Shared by generate and stream.
 * @param {'generate' | 'stream'} method Which SDK entry to call.
 * @param {object} request Caller's generate/stream request.
 * @param {object} prepared Budgeter output.
 * @param {object} options Client options.
 * @returns {Promise<object>}
 */
async function invokeSdkCall(method, request, prepared, options) {
  const impl = method === 'generate' ? options.generateTextImpl : options.streamTextImpl;
  if (impl) {
    return impl({
      messages: prepared.messages,
      abortSignal: request.abortSignal,
      outputSchema: request.outputSchema,
    });
  }
  const llm = options.llm;
  const provider = createLlmProvider(llm, { fetch: options.fetch });
  const call = {
    model: provider.chat(llm.modelId),
    messages: prepared.messages,
    abortSignal: request.abortSignal,
    maxRetries: 0,
  };
  if (request.outputSchema) {
    call.output = Output.json({ schema: request.outputSchema });
  }
  return method === 'generate' ? sdkGenerateText(call) : sdkStreamText(call);
}

/**
 * @param {object} request Caller's generate/stream request.
 * @param {object} options Injection + llm slice.
 * @returns {object} prepareModelInput result.
 */
function preflightModelInput(request, options) {
  const llm = options.llm ?? loadConfig().llm;
  if (!readConfiguredLlm(llm)) {
    throw ApiError.fromCode('LLM_CONFIG_UNAVAILABLE');
  }
  options.llm = llm;
  return prepareModelInput({
    modelArtifactRef: llm.artifactId ?? llm.modelId,
    purpose: request.purpose,
    segments: request.segments,
    summarySegment: request.summarySegment,
    toolSchemaTokenOverhead: request.toolSchemaTokenOverhead,
    options: { tokenizer: options.tokenizer, llm },
  });
}
