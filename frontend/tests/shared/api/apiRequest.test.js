import { apiRequest } from '@/shared/api/apiRequest.js';
import { API_BASE_URL } from '@/shared/api/apiConfig.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestAbortedError } from '@/shared/api/ApiError.js';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import { getAccessToken, resetApiSessionForTests, setAccessToken, subscribeSessionCleared } from '@/shared/api/apiSession.js';

/**
 * Builds a mock fetch Response.
 * @param {object} options Response fields.
 * @returns {object}
 */
function jsonResponse({ status, body, headers = {} }) {
  const headerMap = { ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = Object.keys(headerMap).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        return key ? headerMap[key] : null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
    clone() {
      return jsonResponse({ status, body, headers });
    },
  };
}

describe('apiRequest', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    resetRefreshClientForTests();
    vi.unstubAllGlobals();
    document.cookie = 'csrfToken=csrf-test';
  });

  it('returns typed JSON on 200 and attaches Authorization when a token exists', async () => {
    setAccessToken('access-1');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 200, body: { id: 'u1' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/access/auth/me')).resolves.toEqual({ id: 'u1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/access/auth/me`);
    expect(init.headers.Authorization).toBe('Bearer access-1');
    expect(init.headers['Accept-Language']).toBeTruthy();
  });

  it('omits Authorization when no token is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 200, body: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await apiRequest('/health');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('forwards Idempotency-Key when supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 200, body: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await apiRequest('/masters/projects/create', {
      method: 'POST',
      body: { name: 'a' },
      idempotencyKey: 'idem-1',
    });
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['Idempotency-Key']).toBe('idem-1');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('resolves 204 without parsing a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      json: async () => {
        throw new Error('should not parse');
      },
      text: async () => {
        throw new Error('should not parse');
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/access/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('throws ApiError with code and correlationId on 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'email is required',
            reference: 'REQ-b',
          },
        },
        headers: { 'X-Correlation-Id': 'REQ-b' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/access/auth/login', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'email is required',
      correlationId: 'REQ-b',
      status: 400,
    });
  });

  it('triggers one refresh and one retry on 401', async () => {
    setAccessToken('stale');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 200,
          body: { accessToken: 'fresh' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 200, body: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/access/auth/me')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getAccessToken()).toBe('fresh');
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer fresh');
  });

  it('shares one refresh across two concurrent 401s and retries both', async () => {
    setAccessToken('stale');
    let refreshCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url) => {
      if (String(url).endsWith('/access/auth/refresh')) {
        refreshCalls += 1;
        return Promise.resolve(jsonResponse({ status: 200, body: { accessToken: 'fresh-shared' } }));
      }
      if (getAccessToken() === 'fresh-shared') {
        return Promise.resolve(jsonResponse({ status: 200, body: { ok: true } }));
      }
      return Promise.resolve(
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([apiRequest('/a'), apiRequest('/b')]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(refreshCalls).toBe(1);
  });

  it('clears the session once when refresh fails and rethrows the original ApiError', async () => {
    setAccessToken('stale');
    const listener = vi.fn();
    subscribeSessionCleared(listener);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: 401,
          body: {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required.',
              reference: 'REQ-orig',
            },
          },
          headers: { 'X-Correlation-Id': 'REQ-orig' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 401,
          body: { error: { code: 'SESSION_EXPIRED', message: 'Session expired.' } },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/access/auth/me')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      correlationId: 'REQ-orig',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
  });

  it('does not refresh when skipAuthRefresh is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        status: 401,
        body: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or credentials.' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/access/auth/login', { method: 'POST', body: {}, skipAuthRefresh: true })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a second time when the retried request still returns 401', async () => {
    setAccessToken('stale');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 200, body: { accessToken: 'fresh' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: 401,
          body: { error: { code: 'FORBIDDEN', message: 'No permission.' } },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest('/secret')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getAccessToken()).toBeNull();
  });

  it('rejects with an abort-shaped error when the request is aborted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/access/auth/me', { signal: AbortSignal.abort() })).rejects.toSatisfy(
      (error) => error.name === 'AbortError' || error instanceof RequestAbortedError,
    );
  });

  it('maps a rejected fetch to NETWORK', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiRequest('/access/auth/me')).rejects.toMatchObject({
      code: 'NETWORK',
      status: 0,
    });
  });

  it('builds paths without a leading slash under the base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 200, body: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await apiRequest('access/auth/me');
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/access/auth/me`);
  });

  it('returns undefined for an empty 200 body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '',
      }),
    );
    await expect(apiRequest('/access/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('throws UNEXPECTED when a success body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'REQ-x' },
        text: async () => 'not-json',
      }),
    );
    await expect(apiRequest('/weird')).rejects.toMatchObject({
      code: 'UNEXPECTED',
      correlationId: 'REQ-x',
    });
  });
});
