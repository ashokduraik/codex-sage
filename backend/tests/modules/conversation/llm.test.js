/**
 * OpenAI-compatible startup probe and budgeted generate/stream client.
 * Collaborators (ai SDK, config, budgeter) are mocked — no product option seams.
 */
import { ApiError } from '../../../src/platform/errors.js';
import { getCatalogEntry } from '../../../src/platform/errorCatalog.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  streamText,
  generateText,
  assertLlmAvailable,
  getLlmConfigStatus,
  INFERENCE_QUEUE_MAX_DEPTH,
  INFERENCE_QUEUE_MAX_CONCURRENCY,
} from '../../../src/modules/conversation/index.js';

const { mockGenerateText, mockStreamText, mockPrepareModelInput, mockLoadConfig, configState, LLM, READY_LLM } = vi.hoisted(() => {
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
  const configState = { llm: { ...READY_LLM } };
  return {
    LLM,
    READY_LLM,
    configState,
    mockGenerateText: vi.fn(),
    mockStreamText: vi.fn(),
    mockPrepareModelInput: vi.fn(),
    mockLoadConfig: vi.fn(() => ({ llm: configState.llm })),
  };
});

vi.mock('ai', () => ({
  generateText: (...args) => mockGenerateText(...args),
  streamText: (...args) => mockStreamText(...args),
  Output: {
    json: ({ schema }) => ({ type: 'json', schema }),
  },
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => ({
    chat: (modelId) => ({ provider: 'mock-openai', modelId }),
  }),
}));

vi.mock('../../../src/platform/config.js', () => ({
  loadConfig: (...args) => mockLoadConfig(...args),
}));

vi.mock('../../../src/modules/conversation/contextBudgeter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    prepareModelInput: (...args) => mockPrepareModelInput(...args),
  };
});

const silentLog = {
  info: () => {},
  error: () => {},
};

const underBudgetRequest = {
  purpose: 'understand',
  segments: [{ id: 'q1', kind: 'user_question', content: 'How does login work?', protected: true }],
};

const preparedFixture = {
  messages: [{ role: 'user', content: 'How does login work?' }],
  measuredInputTokens: 5,
  maximumInputBudget: 1000,
  reservedOutputTokens: 256,
  validatedContextCapacity: 131072,
  compactionActions: [],
};

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

beforeEach(() => {
  configState.llm = { ...READY_LLM };
  mockLoadConfig.mockImplementation(() => ({ llm: configState.llm }));
  mockPrepareModelInput.mockReset();
  mockPrepareModelInput.mockImplementation(() => ({ ...preparedFixture }));
  mockGenerateText.mockReset();
  mockStreamText.mockReset();
});

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

  it('uses global fetch for GET /models', async () => {
    const fetchMock = vi.fn(async (url) => {
      expect(url).toBe('http://127.0.0.1:11434/v1/models');
      return new Response(JSON.stringify({ data: [{ id: LLM.modelId }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(assertLlmAvailable(LLM, silentLog)).resolves.toEqual({
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
  it('reports the model id from the given slice', () => {
    expect(getLlmConfigStatus(LLM)).toEqual({ ready: true, modelId: LLM.modelId });
  });

  it('reads loadConfig when no slice is passed', () => {
    configState.llm = { ...READY_LLM };
    expect(getLlmConfigStatus()).toEqual({ ready: true, modelId: LLM.modelId });
  });
});

describe('generateText', () => {
  it('maps usage when the mock provides counts and never invents a total', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Login checks the JWT.',
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    const result = await generateText(underBudgetRequest);
    expect(result.text).toBe('Login checks the JWT.');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: null });
    expect(result.modelId).toBe(LLM.modelId);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.contextMetrics.measuredInputTokens).toBe(5);
    expect(result.contextMetrics.compactionActions).toEqual([]);
  });

  it('returns null usage when the provider omitted counts', async () => {
    mockGenerateText.mockResolvedValue({ text: 'ok' });
    const result = await generateText(underBudgetRequest);
    expect(result.usage).toBeNull();
    expect(result.text).toBe('ok');
  });

  it('treats empty text as an empty string', async () => {
    mockGenerateText.mockResolvedValue({});
    const result = await generateText(underBudgetRequest);
    expect(result.text).toBe('');
    expect(result.usage).toBeNull();
  });

  it('passes outputSchema through Output.json to the SDK', async () => {
    mockGenerateText.mockResolvedValue({ text: '{}' });
    await generateText({ ...underBudgetRequest, purpose: 'draft', outputSchema: { type: 'object' } });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { type: 'json', schema: { type: 'object' } },
        messages: preparedFixture.messages,
        maxRetries: 0,
      }),
    );
  });

  it('does not call the SDK when prepareModelInput fails', async () => {
    mockPrepareModelInput.mockImplementation(() => {
      throw ApiError.fromCode('CONTEXT_ACCOUNTING_UNAVAILABLE');
    });
    await expect(generateText(underBudgetRequest)).rejects.toMatchObject({
      code: 'CONTEXT_ACCOUNTING_UNAVAILABLE',
    });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('does not call the SDK when the question exceeds the budget', async () => {
    mockPrepareModelInput.mockImplementation(() => {
      throw ApiError.fromCode('CONTEXT_BUDGET_EXCEEDED');
    });
    await expect(generateText(underBudgetRequest)).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('rejects when the process queue is full', async () => {
    let releaseAll;
    const sharedGate = new Promise((resolve) => {
      releaseAll = resolve;
    });
    mockGenerateText.mockImplementation(async () => {
      await sharedGate;
      return { text: 'ok' };
    });
    const pending = [];
    for (let index = 0; index < INFERENCE_QUEUE_MAX_DEPTH; index += 1) {
      pending.push(generateText(underBudgetRequest));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(mockGenerateText).toHaveBeenCalledTimes(INFERENCE_QUEUE_MAX_CONCURRENCY);
    await expect(generateText(underBudgetRequest)).rejects.toMatchObject({ code: 'LLM_QUEUE_FULL' });
    releaseAll();
    await Promise.all(pending);
  });

  it('starts the second task only after the first finishes when concurrency is 1', async () => {
    const started = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    mockGenerateText.mockImplementation(async () => {
      started.push(started.length + 1);
      if (started.length === 1) {
        await firstGate;
      }
      return { text: `n${started.length}` };
    });
    const first = generateText(underBudgetRequest);
    const second = generateText(underBudgetRequest);
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([1]);
    releaseFirst();
    await first;
    await second;
    expect(started).toEqual([1, 2]);
  });

  it('maps provider throws to LLM_PROVIDER_ERROR with temporary retryability', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGenerateText.mockRejectedValue(new Error('upstream 500'));
    try {
      await generateText(underBudgetRequest);
      expect.fail('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe('LLM_PROVIDER_ERROR');
      expect(getCatalogEntry(error.code).retryability).toBe('temporary');
      expect(error.cause).toMatchObject({ message: 'upstream 500' });
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('upstream 500'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('calls the SDK generate entry with budgeted messages', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'hi',
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    });
    const result = await generateText(underBudgetRequest);
    expect(result.text).toBe('hi');
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: preparedFixture.messages,
        maxRetries: 0,
      }),
    );
    expect(mockPrepareModelInput).toHaveBeenCalledWith(
      expect.objectContaining({
        modelArtifactRef: LLM.modelId,
        purpose: 'understand',
        options: { llm: expect.objectContaining({ modelId: LLM.modelId }) },
      }),
    );
  });

  it('returns null usage when the SDK reports a non-object usage value', async () => {
    mockGenerateText.mockResolvedValue({ text: 'x', usage: 4 });
    const result = await generateText(underBudgetRequest);
    expect(result.usage).toBeNull();
  });

  it('re-throws catalog errors from the queue without wrapping', async () => {
    mockGenerateText.mockRejectedValue(ApiError.fromCode('LLM_QUEUE_FULL'));
    await expect(generateText(underBudgetRequest)).rejects.toMatchObject({ code: 'LLM_QUEUE_FULL' });
  });
});

describe('streamText', () => {
  it('yields chunks and resolves usage plus duration after the stream ends', async () => {
    mockStreamText.mockResolvedValue({
      textStream: (async function* chunks() {
        yield 'Hel';
        yield 'lo';
      })(),
      usage: Promise.resolve({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
    });
    const result = await streamText(underBudgetRequest);
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
    const usage = Promise.reject(new Error('no usage'));
    // Avoid an unhandled rejection before stream settle awaits this promise.
    void usage.catch(() => {});
    mockStreamText.mockResolvedValue({
      textStream: (async function* chunks() {
        yield 'x';
      })(),
      usage,
    });
    const result = await streamText(underBudgetRequest);
    for await (const _chunk of result.textStream) {
      // drain
    }
    await expect(result.usage).resolves.toBeNull();
  });

  it('honors abortSignal on a delayed stream', async () => {
    const controller = new AbortController();
    mockStreamText.mockImplementation(async ({ abortSignal }) => ({
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
    }));
    const result = await streamText({ ...underBudgetRequest, abortSignal: controller.signal });
    const consumed = result.textStream[Symbol.asyncIterator]();
    await expect(consumed.next()).resolves.toMatchObject({ value: 'start' });
    const waiting = consumed.next();
    controller.abort();
    await expect(waiting).rejects.toThrow();
    await expect(result.usage).resolves.toBeNull();
    await expect(result.durationMs).resolves.toBeGreaterThanOrEqual(0);
  });

  it('calls the SDK stream entry with budgeted messages', async () => {
    mockStreamText.mockResolvedValue({
      textStream: (async function* chunks() {
        yield 'hi';
      })(),
      usage: Promise.resolve({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
    });
    const result = await streamText(underBudgetRequest);
    const parts = [];
    for await (const chunk of result.textStream) {
      parts.push(chunk);
    }
    expect(parts.join('')).toBe('hi');
    await expect(result.usage).resolves.toEqual({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: preparedFixture.messages,
        maxRetries: 0,
      }),
    );
  });

  it('passes outputSchema to Output.json on stream', async () => {
    mockStreamText.mockResolvedValue({
      textStream: (async function* chunks() {
        yield '{}';
      })(),
      usage: Promise.resolve(null),
    });
    const result = await streamText({ ...underBudgetRequest, outputSchema: { type: 'object' } });
    for await (const _chunk of result.textStream) {
      // drain
    }
    expect(mockStreamText).toHaveBeenCalledWith(
      expect.objectContaining({
        output: { type: 'json', schema: { type: 'object' } },
      }),
    );
  });

  it('resolves null usage when the SDK omits a usage field', async () => {
    mockStreamText.mockResolvedValue({
      textStream: (async function* chunks() {
        yield 'z';
      })(),
    });
    const result = await streamText(underBudgetRequest);
    for await (const _chunk of result.textStream) {
      // drain
    }
    await expect(result.usage).resolves.toBeNull();
  });

  it('maps a stream start failure to LLM_PROVIDER_ERROR', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStreamText.mockRejectedValue(new Error('cannot stream'));
    try {
      await expect(streamText(underBudgetRequest)).rejects.toMatchObject({
        code: 'LLM_PROVIDER_ERROR',
        cause: expect.objectContaining({ message: 'cannot stream' }),
      });
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('cannot stream'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
