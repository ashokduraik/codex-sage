/**
 * Conversation LLM client — startup GET /models probe plus budgeted, queued
 * generateText and streamText. No HTTP responses, no model pull.
 */
import { createOpenAI } from '@ai-sdk/openai';
import { loadConfig } from '../../platform/config.js';
import { prepareModelInput } from './contextBudgeter.js';
import { generateText as sdkGenerateText, Output, streamText as sdkStreamText } from 'ai';
import { ApiError, apiErrorFromCaught, caughtErrorFields } from '../../platform/errors.js';

/** Fail the probe if the provider does not answer within this window. */
export const LLM_PROBE_TIMEOUT_MS = 10_000;

/**
 * Waiting + running tasks allowed per API worker before LLM_QUEUE_FULL.
 * Backpressure, not a measured host limit.
 */
export const INFERENCE_QUEUE_MAX_DEPTH = 8;

/**
 * Host-safe default when config is unavailable (tests that mock loadConfig).
 * Production concurrency comes from LLM_QUEUE_MAX_CONCURRENCY via loadConfig.
 */
export const INFERENCE_QUEUE_MAX_CONCURRENCY = 1;

const defaultLog = {
  info: (obj, msg) => console.info(JSON.stringify({ level: 'info', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

/** Default queue for the API process (per worker). */
let defaultInferenceQueue;

/**
 * Env LLM slice status. baseUrl/modelId are required by loadConfig; the process
 * fails closed at startup via assertLlmAvailable — not re-checked per request.
 * @param {{ baseUrl?: string, modelId?: string }} [llm] Connection slice; defaults to loadConfig().
 * @returns {{ ready: boolean, modelId: string | null }}
 */
export function getLlmConfigStatus(llm) {
  const slice = llm ?? loadConfig().llm;
  return { ready: true, modelId: slice.modelId ?? null };
}

/**
 * Proves the OpenAI-compatible host is up and the configured model id is listed.
 * GET /models uses the same baseURL and Bearer rules as createOpenAI for generate/stream.
 * No generate, no pull.
 * @param {{ baseUrl: string, modelId: string, apiKey?: string | null }} llm Env-backed connection slice.
 * @param {{ info: Function, error: Function }} [log] Structured logger (startup / boot).
 * @returns {Promise<{ artifactId: string }>}
 * @throws {Error} When the host is down or the model id is missing from GET /models.
 */
export async function assertLlmAvailable(llm, log = defaultLog) {
  let host;
  try {
    host = new URL(llm.baseUrl).host;
  } catch {
    host = '(unparseable)';
  }
  const modelId = llm.modelId;
  const modelsRoot = llm.baseUrl.endsWith('/') ? llm.baseUrl : `${llm.baseUrl}/`;
  const headers = { accept: 'application/json' };
  if (typeof llm.apiKey === 'string' && llm.apiKey !== '') {
    headers.authorization = `Bearer ${llm.apiKey}`;
  }
  try {
    const response = await globalThis.fetch(new URL('models', modelsRoot).href, {
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
    log.error({ host, modelId, ...caughtErrorFields(error) }, 'llm probe failed');
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
 *   enableThinking?: boolean,
 * }} request Assembly for prepareModelInput plus optional abort/schema.
 *   `enableThinking` defaults to false (UNDERSTAND / tool-choice). Phase 49 may
 *   pass true for DRAFT; private reasoning is never returned or logged.
 * @returns {Promise<{
 *   text: string,
 *   usage: object | null,
 *   durationMs: number,
 *   modelId: string,
 *   contextMetrics: object,
 *   enableThinking: boolean,
 * }>}
 * @throws When config, budget, queue, or the provider fails.
 */
export async function generateText(request) {
  const enableThinking = request.enableThinking === true;
  const llm = loadConfig().llm;
  const prepared = prepareModelInput({
    modelArtifactRef: llm.artifactId ?? llm.modelId,
    purpose: request.purpose,
    segments: request.segments,
    summarySegment: request.summarySegment,
    toolSchemaTokenOverhead: request.toolSchemaTokenOverhead,
    options: { llm },
  });
  const queue = (defaultInferenceQueue ??= createInferenceQueue());
  try {
    const { text, usage, durationMs } = await queue.enqueue(async () => {
      const startedAt = Date.now();
      const provider = createOpenAI({
        baseURL: llm.baseUrl,
        apiKey: llm.apiKey || 'not-needed',
      });
      const call = {
        model: provider.chat(llm.modelId),
        messages: prepared.messages,
        abortSignal: request.abortSignal,
        maxRetries: 0,
        ...providerCallOptionsForThinking(enableThinking),
      };
      if (request.outputSchema) {
        call.output = Output.json({ schema: request.outputSchema });
      }
      const result = await sdkGenerateText(call);
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
      modelId: llm.modelId,
      contextMetrics: contextMetricsFromPrepared(prepared),
      enableThinking,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw apiErrorFromCaught('LLM_PROVIDER_ERROR', error, {
      log: defaultLog,
      logMessage: 'llm provider call failed',
    });
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
 *   enableThinking?: boolean,
 * }} request Assembly for prepareModelInput plus optional abort/schema.
 *   `enableThinking` defaults to false; private reasoning is never yielded or logged.
 * @returns {Promise<{
 *   textStream: AsyncIterable<string>,
 *   usage: Promise<object | null>,
 *   durationMs: Promise<number>,
 *   modelId: string,
 *   contextMetrics: object,
 *   enableThinking: boolean,
 * }>}
 * @throws When config, budget, queue, or starting the provider fails.
 */
export async function streamText(request) {
  const enableThinking = request.enableThinking === true;
  const llm = loadConfig().llm;
  const prepared = prepareModelInput({
    modelArtifactRef: llm.artifactId ?? llm.modelId,
    purpose: request.purpose,
    segments: request.segments,
    summarySegment: request.summarySegment,
    toolSchemaTokenOverhead: request.toolSchemaTokenOverhead,
    options: { llm },
  });
  const queue = (defaultInferenceQueue ??= createInferenceQueue());
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
      const provider = createOpenAI({
        baseURL: llm.baseUrl,
        apiKey: llm.apiKey || 'not-needed',
      });
      const call = {
        model: provider.chat(llm.modelId),
        messages: prepared.messages,
        abortSignal: request.abortSignal,
        maxRetries: 0,
        ...providerCallOptionsForThinking(enableThinking),
      };
      if (request.outputSchema) {
        call.output = Output.json({ schema: request.outputSchema });
      }
      return sdkStreamText(call);
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw apiErrorFromCaught('LLM_PROVIDER_ERROR', error, {
      log: defaultLog,
      logMessage: 'llm provider call failed',
    });
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
    modelId: llm.modelId,
    contextMetrics: contextMetricsFromPrepared(prepared),
    enableThinking,
  };
}

/**
 * Provider extras for private model reasoning. Default is off. Hosts that ignore
 * these options still get enableThinking=false documented on the return value;
 * callers must never log or persist reasoning text if a host emits it anyway.
 * @param {boolean} enableThinking Whether DRAFT-style reasoning may be requested.
 * @returns {object} Spread into the ai SDK generate/stream call.
 */
function providerCallOptionsForThinking(enableThinking) {
  return {
    providerOptions: {
      openai: {
        chat_template_kwargs: { enable_thinking: enableThinking },
      },
    },
  };
}

/**
 * FIFO queue with a concurrency cap. Rejects before enqueue when full.
 * @returns {{ enqueue: (task: () => Promise<unknown>) => Promise<unknown> }}
 */
function createInferenceQueue() {
  const maxDepth = INFERENCE_QUEUE_MAX_DEPTH;
  let maxConcurrency = INFERENCE_QUEUE_MAX_CONCURRENCY;
  try {
    // Fall back when mocks omit the field — undefined never drains waiting tasks.
    maxConcurrency = loadConfig().llm.queueMaxConcurrency ?? INFERENCE_QUEUE_MAX_CONCURRENCY;
  } catch {
    // Keep the module default when config is not loaded (unit tests).
  }
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
