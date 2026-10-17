import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import { API_BASE_URL, getAccessToken, setAccessToken } from '@/shared/api/index';
import { changePassword, fetchCurrentUser, login, logout } from '@/features/auth/api/authApi.js';

/**
 * Builds a mock fetch Response compatible with apiRequest.
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

describe('authApi', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    resetRefreshClientForTests();
    vi.stubGlobal('fetch', vi.fn());
    document.cookie = 'csrfToken=test-csrf';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiSessionForTests();
    resetRefreshClientForTests();
    document.cookie = 'csrfToken=; Max-Age=0';
  });

  it('login posts credentials, stores the access token, and returns the body', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: {
          accessToken: 'access-1',
          accessTokenExpiresInSeconds: 900,
          user: { id: 'u1', email: 'a@b.co', displayName: 'A' },
        },
      }),
    );

    const result = await login('a@b.co', 'secret');

    expect(result.accessToken).toBe('access-1');
    expect(getAccessToken()).toBe('access-1');
    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/access/auth/login`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ email: 'a@b.co', password: 'secret' }),
      }),
    );
  });

  it('fetchCurrentUser requests /auth/me with the bearer token', async () => {
    setAccessToken('tok');
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: {
          id: 'u1',
          email: 'a@b.co',
          displayName: 'A',
          orgId: 'o1',
          roleIds: [],
          permissions: ['users.manage'],
          mustChangePassword: false,
        },
      }),
    );

    const user = await fetchCurrentUser();

    expect(user.permissions).toEqual(['users.manage']);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('logout sends CSRF and skips refresh', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: { get: () => null },
      async json() {
        return undefined;
      },
      async text() {
        return '';
      },
      clone() {
        return this;
      },
    });

    await logout();

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/access/auth/logout`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'test-csrf' }),
      }),
    );
  });

  it('logout omits CSRF header when the cookie is absent', async () => {
    document.cookie = 'csrfToken=; Max-Age=0';
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: { get: () => null },
      async json() {
        return undefined;
      },
      async text() {
        return '';
      },
      clone() {
        return this;
      },
    });

    await logout();

    expect(fetchMock.mock.calls[0][1].headers['X-CSRF-Token']).toBeUndefined();
  });

  it('login rejects a response without an access token', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: { accessTokenExpiresInSeconds: 900, user: { id: 'u1' } },
      }),
    );

    await expect(login('a@b.co', 'secret')).rejects.toThrow(/missing access token/);
  });

  it('changePassword posts current and new passwords', async () => {
    setAccessToken('tok');
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: {
          passwordChanged: true,
          sessionsRevoked: true,
          reauthenticationRequired: true,
        },
      }),
    );

    const result = await changePassword('old', 'new-password-ok');

    expect(result.reauthenticationRequired).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      currentPassword: 'old',
      newPassword: 'new-password-ok',
    });
  });
});
