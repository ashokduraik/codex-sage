/**
 * OpenAI-compatible startup probe and budgeted generate/stream client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';
import { getCatalogEntry } from '../../../src/platform/errorCatalog.js';
import {
  INFERENCE_QUEUE_MAX_CONCURRENCY,
  INFERENCE_QUEUE_MAX_DEPTH,
  assertLlmAvailable,
  createTokenizerAdapter,
  generateText,
  getLlmConfigStatus,
  streamText,
} from '../../../src/modules/conversation/index.js';

const LLM = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  modelId: 'qwen3.8:latest',
  apiKey: null,
};

const READY_LLM = {
  ...LLM,
  artifactId: LLM.modelId,
  contextCapacity: 131072,
};

const silentLog = {
  info: () => {},
  error: () => {},
};

/**
 * Word-count tokenizer so generate/stream tests do not need a production package.
 * @param {string} text Segment text.
 * @returns {number}
 */
function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

const tokenizer = createTokenizerAdapter({
  countTokens: countWords,
  expectedArtifactId: LLM.modelId,
});

const underBudgetRequest = {
  purpose: 'understand',
  segments: [{ id: 'q1', kind: 'user_question', content: 'How does login work?', protected: true }],
};

/**
 * @param {object} [overrides] Extra list-response fields.
 * @returns {(url: string, options?: RequestInit) => Promise<Response>}
 */
/**
 * OpenAI Chat Completions body the SDK accepts for a one-shot generate.
 * @returns {object}
 */
function chatCompletionBody() {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: LLM.modelId,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}

/**
 * SSE body the SDK accepts for streamText.
 * @returns {string}
 */
function chatCompletionSse() {
  return [
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.8:latest","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"qwen3.8:latest","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
}

/**
 * @param {object} [overrides] Extra list-response fields.
 * @returns {(url: string, options?: RequestInit) => Promise<Response>}
 */
function mockModelsOk(overrides = {}) {
  const data = overrides.data ?? [{ id: LLM.modelId, object: 'model' }];
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/models' || parsed.pathname === '/models') {
      return new Response(JSON.stringify({ object: 'list', data }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
}

/**
 * @param {object} [overrides] generateText options.
 * @returns {object}
 */
function clientOptions(overrides = {}) {
  return {
    llm: READY_LLM,
    tokenizer,
    queue: { maxDepth: INFERENCE_QUEUE_MAX_DEPTH, maxConcurrency: INFERENCE_QUEUE_MAX_CONCURRENCY },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('assertLlmAvailable', () => {
  it('returns artifactId equal to the configured model id', async () => {
    vi.stubGlobal('fetch', mockModelsOk());
    await expect(assertLlmAvailable(LLM, silentLog)).resolves.toEqual({ artifactId: LLM.modelId });
  });

  it('accepts a trailing slash on the OpenAI-compatible root', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(url).toBe('http://127.0.0.1:11434/v1/models');
      return new Response(JSON.stringify({ data: [{ id: LLM.modelId }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await assertLlmAvailable({ ...LLM, baseUrl: 'http://127.0.0.1:11434/v1/' }, silentLog);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('joins /models onto a /v1 root without dropping the version segment', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(url).toBe('http://127.0.0.1:11434/v1/models');
      return new Response(JSON.stringify({ data: [{ id: LLM.modelId }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await assertLlmAvailable(LLM, silentLog);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses an injected fetch on the shared factory', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(url).toBe('http://127.0.0.1:11434/v1/models');
      return new Response(JSON.stringify({ data: [{ id: LLM.modelId }] }), { status: 200 });
    });
    await expect(assertLlmAvailable(LLM, silentLog, { fetch: fetchMock })).resolves.toEqual({
      artifactId: LLM.modelId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends Bearer only when apiKey is set', async () => {
    const fetchMock = vi.fn(async (_url, options = {}) => {
      expect(options.headers.authorization).toBe('Bearer test-key');
      return new Response(JSON.stringify({ data: [{ id: LLM.modelId }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await assertLlmAvailable({ ...LLM, apiKey: 'test-key' }, silentLog);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const noKey = vi.fn(async (_url, options = {}) => {
      expect(options.headers.authorization).toBeUndefined();
      return new Response(JSON.stringify({ data: [{ id: LLM.modelId }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', noKey);
    await assertLlmAvailable({ ...LLM, apiKey: null }, silentLog);
  });

  it('throws when fetch fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('fetch failed');
    });
    await expect(assertLlmAvailable(LLM, silentLog)).rejects.toThrow(/fetch failed/);
  });

  it('logs a generic error name when fetch rejects a non-Error', async () => {
    vi.stubGlobal('fetch', async () => {
      throw 'network-down';
    });
    await expect(assertLlmAvailable(LLM, silentLog)).rejects.toBe('network-down');
  });

  it('throws when GET /models is not OK', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 502 }));
    await expect(assertLlmAvailable(LLM, silentLog)).rejects.toThrow(/GET \/models/);
  });

  it('throws when the model id is missing from the list', async () => {
    vi.stubGlobal('fetch', mockModelsOk({ data: [{ id: 'other-model' }] }));
    await expect(assertLlmAvailable(LLM, silentLog)).rejects.toThrow(/not in GET \/models/);
  });

  it('does not match a prefix or alias of the model id', async () => {
    vi.stubGlobal('fetch', mockModelsOk({ data: [{ id: 'qwen3.8' }] }));
    await expect(assertLlmAvailable(LLM, silentLog)).rejects.toThrow(/not in GET \/models/);
  });

  it('throws when the list body is not an array', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ object: 'list' }), { status: 200 }));
    await expect(assertLlmAvailable(LLM, silentLog)).rejects.toThrow(/not in GET \/models/);
  });

  it('treats a non-JSON body as no models', async () => {
    vi.stubGlobal('fetch', async () => new Response('not-json', { status: 200 }));
    await expect(assertLlmAvailable(LLM, silentLog)).rejects.toThrow(/not in GET \/models/);
  });

  it('logs with the default console logger and accepts an unparseable host', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', mockModelsOk());
    await expect(assertLlmAvailable(LLM)).resolves.toEqual({ artifactId: LLM.modelId });
    expect(info).toHaveBeenCalled();

    await expect(assertLlmAvailable({ baseUrl: 'not-a-url', modelId: LLM.modelId })).rejects.toThrow();
    expect(error).toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
  });
});

describe('getLlmConfigStatus', () => {
  it('is ready when baseUrl and modelId are present', () => {
    expect(getLlmConfigStatus(LLM)).toEqual({ ready: true, modelId: LLM.modelId });
  });

  it('is not ready when modelId is missing', () => {
    expect(getLlmConfigStatus({ baseUrl: LLM.baseUrl, modelId: '' })).toEqual({
      ready: false,
      modelId: null,
    });
  });
});

describe('generateText', () => {
  it('maps usage when the mock provides counts and never invents a total', async () => {
    const result = await generateText(
      underBudgetRequest,
      clientOptions({
        generateTextImpl: async () => ({
          text: 'Login checks the JWT.',
          usage: { inputTokens: 10, outputTokens: 4 },
        }),
      }),
    );
    expect(result.text).toBe('Login checks the JWT.');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: null });
    expect(result.modelId).toBe(LLM.modelId);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.contextMetrics.measuredInputTokens).toBeGreaterThan(0);
    expect(result.contextMetrics.compactionActions).toEqual([]);
  });

  it('returns null usage when the provider omitted counts', async () => {
    const result = await generateText(
      underBudgetRequest,
      clientOptions({
        generateTextImpl: async () => ({ text: 'ok' }),
      }),
    );
    expect(result.usage).toBeNull();
    expect(result.text).toBe('ok');
  });

  it('treats empty text as an empty string', async () => {
    const result = await generateText(
      underBudgetRequest,
      clientOptions({
        generateTextImpl: async () => ({}),
      }),
    );
    expect(result.text).toBe('');
    expect(result.usage).toBeNull();
  });

  it('passes outputSchema through to the injected impl', async () => {
    let seen;
    await generateText(
      { ...underBudgetRequest, purpose: 'draft', outputSchema: { type: 'object' } },
      clientOptions({
        generateTextImpl: async (call) => {
          seen = call.outputSchema;
          return { text: '{}' };
        },
      }),
    );
    expect(seen).toEqual({ type: 'object' });
  });

  it('does not call the SDK when prepareModelInput fails', async () => {
    const generateTextImpl = vi.fn();
    await expect(generateText(underBudgetRequest, clientOptions({ tokenizer: undefined, generateTextImpl }))).rejects.toMatchObject({
      code: 'CONTEXT_ACCOUNTING_UNAVAILABLE',
    });
    expect(generateTextImpl).not.toHaveBeenCalled();
  });

  it('does not call the SDK when the question exceeds the budget', async () => {
    const generateTextImpl = vi.fn();
    await expect(
      generateText(underBudgetRequest, {
        llm: { ...READY_LLM, contextCapacity: 4 },
        tokenizer,
        generateTextImpl,
        queue: { maxDepth: 2, maxConcurrency: 1 },
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
    expect(generateTextImpl).not.toHaveBeenCalled();
  });

  it('throws LLM_CONFIG_UNAVAILABLE when modelId is missing', async () => {
    const generateTextImpl = vi.fn();
    await expect(
      generateText(underBudgetRequest, clientOptions({ llm: { baseUrl: LLM.baseUrl, modelId: '' }, generateTextImpl })),
    ).rejects.toMatchObject({ code: 'LLM_CONFIG_UNAVAILABLE' });
    expect(generateTextImpl).not.toHaveBeenCalled();
  });

  it('rejects the third enqueue when injected depth is 2', async () => {
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const generateTextImpl = vi.fn(async () => {
      await firstGate;
      return { text: 'ok' };
    });
    const options = clientOptions({ generateTextImpl, queue: { maxDepth: 2, maxConcurrency: 1 } });
    const first = generateText(underBudgetRequest, options);
    const second = generateText(underBudgetRequest, options);
    await expect(generateText(underBudgetRequest, options)).rejects.toMatchObject({ code: 'LLM_QUEUE_FULL' });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ text: 'ok' });
    await expect(second).resolves.toMatchObject({ text: 'ok' });
  });

  it('starts the second task only after the first finishes when concurrency is 1', async () => {
    const started = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const generateTextImpl = vi.fn(async () => {
      started.push(started.length + 1);
      if (started.length === 1) {
        await firstGate;
      }
      return { text: `n${started.length}` };
    });
    const options = clientOptions({ generateTextImpl, queue: { maxDepth: 4, maxConcurrency: 1 } });
    const first = generateText(underBudgetRequest, options);
    const second = generateText(underBudgetRequest, options);
    await vi.waitFor(() => {
      expect(started).toEqual([1]);
    });
    releaseFirst();
    await first;
    await second;
    expect(started).toEqual([1, 2]);
  });

  it('maps provider throws to LLM_PROVIDER_ERROR with temporary retryability', async () => {
    try {
      await generateText(
        underBudgetRequest,
        clientOptions({
          generateTextImpl: async () => {
            throw new Error('upstream 500');
          },
        }),
      );
      expect.fail('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe('LLM_PROVIDER_ERROR');
      expect(getCatalogEntry(error.code).retryability).toBe('temporary');
    }
  });

  it('calls Chat Completions through the shared factory when no impl is injected', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(chatCompletionBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await generateText(underBudgetRequest, clientOptions({ fetch: fetchMock }));
    expect(result.text).toBe('hi');
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('passes outputSchema to the SDK Output helper on generate', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ...chatCompletionBody(),
          choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await generateText({ ...underBudgetRequest, outputSchema: { type: 'object' } }, clientOptions({ fetch: fetchMock }));
    expect(result.text).toBe('{}');
    expect(String(fetchMock.mock.calls[0][1]?.body ?? '')).toContain('json_object');
  });

  it('uses the process-default queue when none is injected', async () => {
    const result = await generateText(underBudgetRequest, {
      llm: READY_LLM,
      tokenizer,
      generateTextImpl: async () => ({ text: 'default-queue', usage: { totalTokens: 9 } }),
    });
    expect(result.text).toBe('default-queue');
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: 9 });
  });

  it('returns null usage when the impl reports a non-object usage value', async () => {
    const result = await generateText(
      underBudgetRequest,
      clientOptions({
        generateTextImpl: async () => ({ text: 'x', usage: 4 }),
      }),
    );
    expect(result.usage).toBeNull();
  });

  it('re-throws catalog errors from the queue without wrapping', async () => {
    await expect(
      generateText(
        underBudgetRequest,
        clientOptions({
          queue: {
            enqueue: async () => {
              throw ApiError.fromCode('LLM_QUEUE_FULL');
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'LLM_QUEUE_FULL' });
  });
});

describe('streamText', () => {
  it('yields chunks and resolves usage plus duration after the stream ends', async () => {
    const result = await streamText(
      underBudgetRequest,
      clientOptions({
        streamTextImpl: async () => ({
          textStream: (async function* chunks() {
            yield 'Hel';
            yield 'lo';
          })(),
          usage: Promise.resolve({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
        }),
      }),
    );
    const parts = [];
    for await (const chunk of result.textStream) {
      parts.push(chunk);
    }
    expect(parts.join('')).toBe('Hello');
    await expect(result.usage).resolves.toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    await expect(result.durationMs).resolves.toBeGreaterThanOrEqual(0);
    expect(result.modelId).toBe(LLM.modelId);
  });

  it('resolves null usage when the stream usage promise rejects', async () => {
    const result = await streamText(
      underBudgetRequest,
      clientOptions({
        streamTextImpl: async () => ({
          textStream: (async function* chunks() {
            yield 'x';
          })(),
          usage: Promise.reject(new Error('no usage')),
        }),
      }),
    );
    for await (const _chunk of result.textStream) {
      // drain
    }
    await expect(result.usage).resolves.toBeNull();
  });

  it('honors abortSignal on a delayed stream', async () => {
    const controller = new AbortController();
    const result = await streamText(
      { ...underBudgetRequest, abortSignal: controller.signal },
      clientOptions({
        streamTextImpl: async ({ abortSignal }) => ({
          textStream: (async function* delayed() {
            yield 'start';
            await new Promise((_, reject) => {
              const fail = () => reject(abortSignal.reason ?? new Error('aborted'));
              if (abortSignal.aborted) {
                fail();
                return;
              }
              abortSignal.addEventListener('abort', fail);
            });
          })(),
        }),
      }),
    );
    const consumed = result.textStream[Symbol.asyncIterator]();
    await expect(consumed.next()).resolves.toMatchObject({ value: 'start' });
    const waiting = consumed.next();
    controller.abort();
    await expect(waiting).rejects.toThrow();
    await expect(result.usage).resolves.toBeNull();
    await expect(result.durationMs).resolves.toBeGreaterThanOrEqual(0);
  });

  it('streams Chat Completions through the shared factory when no impl is injected', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(chatCompletionSse(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const result = await streamText(underBudgetRequest, clientOptions({ fetch: fetchMock }));
    const parts = [];
    for await (const chunk of result.textStream) {
      parts.push(chunk);
    }
    expect(parts.join('')).toBe('hi');
    await expect(result.usage).resolves.toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('passes outputSchema to the SDK Output helper on stream', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(chatCompletionSse(), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const result = await streamText({ ...underBudgetRequest, outputSchema: { type: 'object' } }, clientOptions({ fetch: fetchMock }));
    for await (const _chunk of result.textStream) {
      // drain
    }
    expect(String(fetchMock.mock.calls[0][1]?.body ?? '')).toContain('json_object');
  });

  it('resolves null usage when the impl omits a usage field', async () => {
    const result = await streamText(
      underBudgetRequest,
      clientOptions({
        streamTextImpl: async () => ({
          textStream: (async function* chunks() {
            yield 'z';
          })(),
        }),
      }),
    );
    for await (const _chunk of result.textStream) {
      // drain
    }
    await expect(result.usage).resolves.toBeNull();
  });

  it('maps a stream start failure to LLM_PROVIDER_ERROR', async () => {
    await expect(
      streamText(
        underBudgetRequest,
        clientOptions({
          streamTextImpl: async () => {
            throw new Error('cannot stream');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
  });
});
