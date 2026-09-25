import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/features/auth/AuthContext';
import { CURRENT_USER_QUERY_KEY } from '@/features/auth/api/authApi.js';
import { clearSession, getAccessToken, setAccessToken } from '@/shared/api';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import {
  buildTestAuthUser,
  clearAuthSession,
  seedAuthSession,
} from '@/test/renderWithProviders';

afterEach(() => {
  cleanup();
  clearAuthSession();
  vi.unstubAllGlobals();
  resetRefreshClientForTests();
});

/**
 * Builds a mock fetch Response compatible with apiRequest.
 * @param {object} options Response fields.
 * @returns {object}
 */
function jsonResponse({ status = 200, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() {
      return body;
    },
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
    clone() {
      return jsonResponse({ status, body });
    },
  };
}

/**
 * Render a hook under QueryClient + AuthProvider + MemoryRouter.
 * @param {string} [initialPath]
 * @param {object} [seedUser]
 */
function renderAuthHook(initialPath = '/', seedUser = null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (seedUser) {
    setAccessToken('test-access-token');
    queryClient.setQueryData(CURRENT_USER_QUERY_KEY, seedUser);
  }
  return renderHook(() => useAuth(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <AuthProvider>{children}</AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
}

describe('AuthContext', () => {
  beforeEach(() => {
    clearAuthSession();
    resetRefreshClientForTests();
    document.cookie = 'csrfToken=test-csrf';
  });

  it('logs in successfully and exposes the user', async () => {
    const user = buildTestAuthUser('admin@acme.io');
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/auth/login')) {
        return jsonResponse({
          status: 200,
          body: {
            accessToken: 'access-login',
            accessTokenExpiresInSeconds: 900,
            user: { id: user.id, email: user.email, displayName: user.displayName },
          },
        });
      }
      if (String(url).endsWith('/auth/me')) {
        return jsonResponse({ status: 200, body: user });
      }
      return jsonResponse({
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED', message: 'nope' } },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderAuthHook();
    await waitFor(() => expect(result.current.authChecked).toBe(true));

    await act(async () => {
      await result.current.login('admin@acme.io', 'secret');
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.email).toBe('admin@acme.io');
    expect(getAccessToken()).toBe('access-login');
    expect(localStorage.getItem('codex-sage-auth')).toBeNull();
  });

  it('rejects login when email or password is empty', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { result } = renderAuthHook();
    await waitFor(() => expect(result.current.authChecked).toBe(true));

    await expect(
      act(async () => {
        await result.current.login(' ', '');
      }),
    ).rejects.toThrow(/Email and password are required/);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('resolves a seeded session without writing localStorage', async () => {
    const user = seedAuthSession('restored@acme.io');
    const { result } = renderAuthHook('/', user);
    await waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.user?.email).toBe('restored@acme.io');
      expect(result.current.authChecked).toBe(true);
    });
    expect(localStorage.getItem('codex-sage-auth')).toBeNull();
  });

  it('leaves the user signed out when boot refresh fails', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        status: 401,
        body: { error: { code: 'UNAUTHENTICATED', message: 'nope' } },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderAuthHook();
    await waitFor(() => expect(result.current.authChecked).toBe(true));
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it('clears the cache and navigates when the session is cleared', async () => {
    const user = seedAuthSession('you@acme.io');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
    queryClient.setQueryData(['projects'], [{ id: 'p1' }]);

    function Probe() {
      const auth = useAuth();
      return (
        <div>
          <span data-testid="auth-flag">{auth.isAuthenticated ? 'yes' : 'no'}</span>
          <span data-testid="path">{window.location.pathname}</span>
        </div>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/projects']}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('auth-flag').textContent).toBe('yes'));

    act(() => {
      clearSession();
    });

    await waitFor(() => {
      expect(screen.getByTestId('auth-flag').textContent).toBe('no');
    });
    expect(queryClient.getQueryData(['projects'])).toBeUndefined();
  });

  it('logs out, clears the token, and navigates to login', async () => {
    const user = seedAuthSession('you@acme.io');
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/auth/logout')) {
        return {
          ok: true,
          status: 204,
          headers: { get: () => null },
          async text() {
            return '';
          },
          async json() {
            return undefined;
          },
          clone() {
            return this;
          },
        };
      }
      return jsonResponse({ status: 200, body: user });
    });
    vi.stubGlobal('fetch', fetchMock);

    function Probe() {
      const auth = useAuth();
      return (
        <div>
          <span data-testid="auth-flag">{auth.isAuthenticated ? 'yes' : 'no'}</span>
          <button type="button" onClick={() => void auth.logout()}>
            Logout
          </button>
        </div>
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('auth-flag').textContent).toBe('yes'));

    await act(async () => {
      screen.getByRole('button', { name: 'Logout' }).click();
    });

    await waitFor(() => expect(screen.getByTestId('auth-flag').textContent).toBe('no'));
    expect(getAccessToken()).toBeNull();
  });

  it('boots successfully when refresh returns a token', async () => {
    const user = buildTestAuthUser('boot@acme.io');
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/auth/refresh')) {
        return jsonResponse({
          status: 200,
          body: {
            accessToken: 'boot-token',
            accessTokenExpiresInSeconds: 900,
            user,
          },
        });
      }
      if (String(url).endsWith('/auth/me')) {
        return jsonResponse({ status: 200, body: user });
      }
      return jsonResponse({
        status: 500,
        body: { error: { code: 'UNEXPECTED', message: 'x' } },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderAuthHook();
    await waitFor(() => {
      expect(result.current.authChecked).toBe(true);
      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.user?.email).toBe('boot@acme.io');
    });
    expect(getAccessToken()).toBe('boot-token');
  });

  it('ignores session-cleared notifications during intentional logout', async () => {
    const user = seedAuthSession('you@acme.io');
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/auth/logout')) {
        return {
          ok: true,
          status: 204,
          headers: { get: () => null },
          async text() {
            return '';
          },
          async json() {
            return undefined;
          },
          clone() {
            return this;
          },
        };
      }
      return jsonResponse({ status: 200, body: user });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderAuthHook('/', user);
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    await act(async () => {
      await result.current.logout(false);
    });

    act(() => {
      clearSession();
    });

    expect(result.current.isAuthenticated).toBe(false);
  });

  it('skips expiry navigation when already on login', async () => {
    window.history.replaceState({}, '', '/login');
    const user = seedAuthSession('you@acme.io');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);

    function Probe() {
      const auth = useAuth();
      return <span data-testid="auth-flag">{auth.isAuthenticated ? 'yes' : 'no'}</span>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/login']}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('auth-flag').textContent).toBe('yes'));

    act(() => {
      clearSession();
    });

    await waitFor(() => expect(screen.getByTestId('auth-flag').textContent).toBe('no'));
  });

  it('throws when useAuth is called outside AuthProvider', () => {
    expect(() => renderHook(() => useAuth())).toThrow(
      /useAuth must be used within an AuthProvider/,
    );
  });
});
