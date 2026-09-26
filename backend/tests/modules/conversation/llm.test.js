/**
 * OpenAI-compatible startup probe: GET /models, exact model id, optional Bearer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertLlmAvailable } from '../../../src/modules/conversation/index.js';

const LLM = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  modelId: 'qwen3.8:latest',
  apiKey: null,
};

const silentLog = {
  info: () => {},
  error: () => {},
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
