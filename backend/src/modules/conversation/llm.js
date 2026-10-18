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
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

/** Default queue for the API process (per worker). */
let defaultInferenceQueue;

/**
 * Artifact id from the last successful assertLlmAvailable in this process.
 * loadConfig() rebuilds from env and never includes artifactId — generate/stream
 * must keep the probed value after API boot.
 */
let probedLlmArtifactId = null;

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
 * Clears the process-start LLM artifact id (unit tests only).
 * @returns {void}
 */
export function resetProbedLlmArtifactIdForTests() {
  probedLlmArtifactId = null;
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
    probedLlmArtifactId = modelId;
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
  const llm = loadLlmSliceForInference();
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
      const prompt = splitPromptForSdk(prepared.messages);
      const call = {
        model: provider.chat(llm.modelId),
        ...prompt,
        abortSignal: request.abortSignal,
        maxRetries: 0,
        ...providerCallOptionsForThinking(enableThinking),
      };
      if (request.outputSchema) {
        call.output = Output.json({ schema: request.outputSchema });
      }
      try {
        const result = await sdkGenerateText(call);
        return {
          text: typeof result?.text === 'string' ? result.text : '',
          usage: mapUsage(result?.usage),
          durationMs: Date.now() - startedAt,
        };
      } catch (providerError) {
        // Output.json throws before returning text; soft-return so callers can repair.
        if (request.outputSchema && isNoObjectGeneratedError(providerError)) {
          defaultLog.warn?.(
            { purpose: request.purpose, ...caughtErrorFields(providerError) },
            'llm structured output parse failed; returning raw text for soft parse',
          );
          return {
            text: rawTextFromNoObjectGeneratedError(providerError),
            usage: mapUsage(usageFromNoObjectGeneratedError(providerError)),
            durationMs: Date.now() - startedAt,
          };
        }
        throw providerError;
      }
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
 * Queued Chat Completions generate that skips context budgeting and the tokenizer.
 * For short non-chat jobs that do not need prepareModelInput (ADR 0038 still budgets chat).
 * Do not use for grounded chat answers. AI SDK v7: pass system text via `instructions`.
 * @param {{
 *   purpose: string,
 *   instructions: string,
 *   messages: { role: string, content: string }[],
 *   abortSignal?: AbortSignal,
 *   enableThinking?: boolean,
 * }} request Ready instructions + non-system messages (caller truncates README etc.).
 * @returns {Promise<{
 *   text: string,
 *   usage: object | null,
 *   durationMs: number,
 *   modelId: string,
 *   enableThinking: boolean,
 * }>}
 * @throws When config, queue, validation, or the provider fails.
 */
export async function generateTextWithoutBudget(request) {
  const enableThinking = request.enableThinking === true;
  const llm = loadConfig().llm;
  const instructions = typeof request.instructions === 'string' ? request.instructions.trim() : '';
  if (!instructions) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'instructions', message: 'instructions must be a non-empty string' }],
    });
  }
  const messages = Array.isArray(request.messages) ? request.messages : [];
  if (messages.length === 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'messages', message: 'messages must be a non-empty array' }],
    });
  }
  if (messages.some((message) => message?.role === 'system')) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'messages', message: 'system role is not allowed in messages; use instructions' }],
    });
  }
  const queue = (defaultInferenceQueue ??= createInferenceQueue());
  try {
    const { text, usage, durationMs } = await queue.enqueue(async () => {
      const startedAt = Date.now();
      const provider = createOpenAI({
        baseURL: llm.baseUrl,
        apiKey: llm.apiKey || 'not-needed',
      });
      const result = await sdkGenerateText({
        model: provider.chat(llm.modelId),
        instructions,
        messages,
        abortSignal: request.abortSignal,
        maxRetries: 0,
        ...providerCallOptionsForThinking(enableThinking),
      });
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
  const llm = loadLlmSliceForInference();
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
      const prompt = splitPromptForSdk(prepared.messages);
      const call = {
        model: provider.chat(llm.modelId),
        ...prompt,
        abortSignal: request.abortSignal,
        maxRetries: 0,
        ...providerCallOptionsForThinking(enableThinking),
      };
      if (request.outputSchema) {
        call.output = Output.json({ schema: request.outputSchema });
      }
      try {
        return await sdkStreamText(call);
      } catch (providerError) {
        // Same soft path as generateText when Output.json fails at stream start.
        if (request.outputSchema && isNoObjectGeneratedError(providerError)) {
          defaultLog.warn?.(
            { purpose: request.purpose, ...caughtErrorFields(providerError) },
            'llm structured output parse failed on stream start; yielding raw text for soft parse',
          );
          const softText = rawTextFromNoObjectGeneratedError(providerError);
          const softUsage = mapUsage(usageFromNoObjectGeneratedError(providerError));
          return {
            textStream: (async function* softStructuredStream() {
              if (softText) {
                yield softText;
              }
            })(),
            usage: Promise.resolve(softUsage),
          };
        }
        throw providerError;
      }
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
 * True when the AI SDK failed to parse Output.json (schema or non-JSON text).
 * @param {unknown} error Caught provider error.
 * @returns {boolean}
 */
function isNoObjectGeneratedError(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  return name === 'AI_NoObjectGeneratedError' || name === 'NoObjectGeneratedError';
}

/**
 * Best-effort raw model text from a structured-output parse failure.
 * @param {unknown} error No-object-generated error from the AI SDK.
 * @returns {string}
 */
function rawTextFromNoObjectGeneratedError(error) {
  if (!error || typeof error !== 'object') {
    return '';
  }
  if ('text' in error && typeof error.text === 'string') {
    return error.text;
  }
  const response = 'response' in error ? error.response : null;
  if (response && typeof response === 'object' && 'text' in response && typeof response.text === 'string') {
    return response.text;
  }
  return '';
}

/**
 * Best-effort usage object on a structured-output parse failure.
 * @param {unknown} error No-object-generated error from the AI SDK.
 * @returns {object | null | undefined}
 */
function usageFromNoObjectGeneratedError(error) {
  if (!error || typeof error !== 'object') {
    return null;
  }
  if ('usage' in error) {
    return error.usage;
  }
  return null;
}

/**
 * Env llm slice with artifactId from the process-start probe when loadConfig omits it.
 * @returns {{ baseUrl: string, modelId: string, contextCapacity: number, artifactId: string | null, apiKey: string | null, queueMaxConcurrency: number, runBudget: object }}
 */
function loadLlmSliceForInference() {
  const loaded = loadConfig().llm;
  const fromConfig = typeof loaded.artifactId === 'string' ? loaded.artifactId.trim() : '';
  return {
    ...loaded,
    artifactId: fromConfig || probedLlmArtifactId,
  };
}

/**
 * AI SDK v7 rejects system roles in `messages`; move them to `instructions`.
 * @param {{ role: string, content: string }[]} messages Budgeter or caller messages.
 * @returns {{ instructions?: string, messages: { role: string, content: string }[] }}
 */
function splitPromptForSdk(messages) {
  const list = Array.isArray(messages) ? messages : [];
  /** @type {string[]} */
  const instructionParts = [];
  /** @type {{ role: string, content: string }[]} */
  const conversationMessages = [];
  for (const message of list) {
    if (message?.role === 'system') {
      instructionParts.push(typeof message.content === 'string' ? message.content : '');
      continue;
    }
    conversationMessages.push(message);
  }
  if (instructionParts.length === 0) {
    return { messages: conversationMessages };
  }
  return {
    instructions: instructionParts.join('\n\n'),
    messages: conversationMessages,
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
