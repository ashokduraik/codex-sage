import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage, { safeReturnTo } from '@/features/auth/LoginPage';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import {
  buildTestAuthUser,
  clearAuthSession,
  renderWithProviders,
} from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
  clearAuthSession();
  vi.unstubAllGlobals();
  resetRefreshClientForTests();
  window.history.replaceState({}, '', '/');
});

/**
 * Builds a mock fetch Response compatible with apiRequest.
 * @param {object} options Response fields.
 * @returns {object}
 */
function jsonResponse({ status = 200, body, headers = {} }) {
  const headerMap = { ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = Object.keys(headerMap).find(
          (candidate) => candidate.toLowerCase() === name.toLowerCase(),
        );
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

describe('LoginPage', () => {
  beforeEach(() => {
    clearAuthSession();
    resetRefreshClientForTests();
  });

  it('renders the login form without Google, register, or forgot links', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );
    renderWithProviders(<LoginPage />, { route: '/login' });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Continue with Google/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Create one/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Forgot password/i })).toBeNull();
    expect(screen.getByText(/Accounts are created by an administrator/i)).toBeTruthy();
    expect(screen.getByText(/Contact your administrator/i)).toBeTruthy();
  });

  it('submits login and navigates on success', async () => {
    const user = buildTestAuthUser('you@acme.io');
    const fetchMock = vi.fn(async (url) => {
      if (String(url).endsWith('/auth/login')) {
        return jsonResponse({
          status: 200,
          body: {
            accessToken: 'tok',
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
        body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<LoginPage />, { route: '/login' });
    await screen.findByRole('heading', { name: 'Welcome back' });

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'you@acme.io' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/auth/login'),
        expect.anything(),
      );
    });
  });

  it('disables the form and sets aria-busy while submitting', async () => {
    let resolveLogin;
    const loginPromise = new Promise((resolve) => {
      resolveLogin = resolve;
    });
    const user = buildTestAuthUser();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).endsWith('/auth/refresh')) {
          return jsonResponse({
            status: 401,
            body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
          });
        }
        if (String(url).endsWith('/auth/login')) {
          await loginPromise;
          return jsonResponse({
            status: 200,
            body: {
              accessToken: 'tok',
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
      }),
    );

    renderWithProviders(<LoginPage />, { route: '/login' });
    await screen.findByRole('button', { name: 'Log in' });

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'you@acme.io' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Logging in/i }).getAttribute('aria-busy')).toBe(
        'true',
      );
      expect(screen.getByLabelText('Email').disabled).toBe(true);
    });

    resolveLogin();
  });

  it('renders backend error.message in a role=alert', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).endsWith('/auth/refresh')) {
          return jsonResponse({
            status: 401,
            body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
          });
        }
        if (String(url).endsWith('/auth/login')) {
          return jsonResponse({
            status: 401,
            body: {
              error: { code: 'INVALID_CREDENTIALS', message: 'Bad credentials from API' },
            },
          });
        }
        return jsonResponse({
          status: 500,
          body: { error: { code: 'UNEXPECTED', message: 'x' } },
        });
      }),
    );

    renderWithProviders(<LoginPage />, { route: '/login' });
    await screen.findByRole('button', { name: 'Log in' });

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'you@acme.io' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Bad credentials from API/);
  });

  it('shows the correlation id when the error carries one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).endsWith('/auth/refresh')) {
          return jsonResponse({
            status: 401,
            body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
          });
        }
        if (String(url).endsWith('/auth/login')) {
          return jsonResponse({
            status: 401,
            body: {
              error: {
                code: 'INVALID_CREDENTIALS',
                message: 'Nope',
                reference: 'corr-123',
              },
            },
            headers: { 'X-Correlation-Id': 'corr-123' },
          });
        }
        return jsonResponse({
          status: 500,
          body: { error: { code: 'UNEXPECTED', message: 'x' } },
        });
      }),
    );

    renderWithProviders(<LoginPage />, { route: '/login' });
    await screen.findByRole('button', { name: 'Log in' });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'you@acme.io' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/corr-123/);
  });

  it('shows the session-expired notice when reason is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );
    window.history.replaceState({}, '', '/login?reason=session_expired');
    renderWithProviders(<LoginPage />, { route: '/login?reason=session_expired' });
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/session ended/i);
  });

  it('shows the password-changed notice when reason is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );
    window.history.replaceState({}, '', '/login?reason=password_changed');
    renderWithProviders(<LoginPage />, { route: '/login?reason=password_changed' });
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/password was updated/i);
  });

  it('shows an alert for empty client-side validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );
    renderWithProviders(<LoginPage />, { route: '/login' });
    await screen.findByRole('button', { name: 'Log in' });
    const form = screen.getByLabelText('Email').closest('form');
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('safeReturnTo', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        origin: 'http://localhost',
        href: 'http://localhost/',
        search: '',
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('returns / when returnTo is missing', () => {
    window.location.search = '';
    expect(safeReturnTo()).toBe('/');
  });

  it('accepts a same-origin path', () => {
    window.location.search = '?returnTo=/projects';
    expect(safeReturnTo()).toBe('/projects');
  });

  it('rejects protocol-relative open redirects', () => {
    window.location.search = '?returnTo=/.//evil.com';
    expect(safeReturnTo()).toBe('/');
  });

  it('rejects backslash open redirects', () => {
    window.location.search = '?returnTo=/\\evil.com';
    expect(safeReturnTo()).toBe('/');
  });

  it('strips sensitive bootstrap query params', () => {
    window.location.search =
      '?returnTo=' + encodeURIComponent('/admin?access_token=secret&keep=1');
    expect(safeReturnTo()).toBe('/admin?keep=1');
  });
});
