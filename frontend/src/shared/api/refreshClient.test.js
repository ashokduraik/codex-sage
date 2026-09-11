import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken, resetApiSessionForTests, subscribeSessionCleared } from './apiSession.js';
import {
  refreshAccessToken,
  resetRefreshClientForTests,
  readCsrfTokenFromCookie,
  CSRF_HEADER_NAME,
} from './refreshClient.js';
import { API_BASE_URL } from './apiConfig.js';

describe('readCsrfTokenFromCookie', () => {
  beforeEach(() => {
    document.cookie.split(';').forEach((part) => {
      const name = part.split('=')[0]?.trim();
      if (name) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    });
  });

  it('returns null when the csrf cookie is absent', () => {
    document.cookie = 'other=value';
    expect(readCsrfTokenFromCookie()).toBeNull();
  });

  it('decodes the csrf cookie value when present among other cookies', () => {
    document.cookie = 'other=1';
    document.cookie = 'csrfToken=a%2Fb';
    expect(readCsrfTokenFromCookie()).toBe('a/b');
  });
});

describe('refreshAccessToken', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    resetRefreshClientForTests();
    vi.unstubAllGlobals();
    document.cookie = 'csrfToken=csrf-test';
  });

  it('stores the new access token on success and sends CSRF + credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ accessToken: 'new-access' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshAccessToken()).resolves.toBe('new-access');
    expect(getAccessToken()).toBe('new-access');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/auth/refresh`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers[CSRF_HEADER_NAME]).toBe('csrf-test');
  });

  it('fails locally without fetching when the csrf cookie is missing', async () => {
    document.cookie = 'csrfToken=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(refreshAccessToken()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken()).toBeNull();
  });

  it('shares one in-flight refresh across concurrent callers', async () => {
    let resolveRefresh;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => null },
              json: async () => ({ accessToken: 'shared' }),
            });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = refreshAccessToken();
    const second = refreshAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveRefresh();
    await expect(Promise.all([first, second])).resolves.toEqual(['shared', 'shared']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears the session once when refresh fails', async () => {
    const listener = vi.fn();
    subscribeSessionCleared(listener);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => 'REQ-r' },
      json: async () => ({
        error: { code: 'SESSION_EXPIRED', message: 'Session expired.', reference: 'REQ-r' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshAccessToken()).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
      status: 401,
    });
    expect(getAccessToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears the session when the error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError('nope');
        },
      }),
    );
    await expect(refreshAccessToken()).rejects.toMatchObject({ code: 'UNEXPECTED' });
  });

  it('does not recurse when the refresh call itself returns 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshAccessToken()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a rejected refresh fetch to NETWORK and clears the session', async () => {
    const listener = vi.fn();
    subscribeSessionCleared(listener);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(refreshAccessToken()).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rethrows abort errors without clearing the session as a network failure', async () => {
    const listener = vi.fn();
    subscribeSessionCleared(listener);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    await expect(refreshAccessToken()).rejects.toMatchObject({ name: 'AbortError' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('clears the session when refresh returns 200 without an accessToken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ user: {} }),
      }),
    );
    await expect(refreshAccessToken()).rejects.toMatchObject({ code: 'UNEXPECTED' });
    expect(getAccessToken()).toBeNull();
  });

  it('clears the session when refresh returns non-JSON on success status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError('bad json');
        },
      }),
    );
    await expect(refreshAccessToken()).rejects.toMatchObject({ code: 'UNEXPECTED' });
  });
});
