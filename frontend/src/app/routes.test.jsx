import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '@/app/routes';
import { AuthProvider } from '@/features/auth/AuthContext';
import LoginPage from '@/features/auth/LoginPage';
import { CURRENT_USER_QUERY_KEY } from '@/features/auth/api/authKeys.js';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import '@/shared/i18n';
import { AppDataProvider } from '@/shared/mock-data';
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
 * Renders routes under query + auth providers.
 * @param {string} path Initial path.
 * @param {object | null} [user] Seeded user.
 */
function renderRoutes(path, user = null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (user) {
    seedAuthSession(user.email, user);
    queryClient.setQueryData(CURRENT_USER_QUERY_KEY, user);
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppDataProvider>
            <AppRoutes />
          </AppDataProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('auth pages', () => {
  beforeEach(() => {
    clearAuthSession();
    resetRefreshClientForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );
  });

  it('renders the login title', async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <MemoryRouter>
          <AuthProvider>
            <AppDataProvider>
              <LoginPage />
            </AppDataProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
  });
});

describe('AppRoutes', () => {
  beforeEach(() => {
    clearAuthSession();
    resetApiSessionForTests();
    resetRefreshClientForTests();
  });

  it('shows login for protected routes when unauthenticated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );
    renderRoutes('/');
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
  });

  it('renders home when authenticated', async () => {
    const user = buildTestAuthUser('you@acme.io');
    renderRoutes('/', user);
    expect(
      await screen.findByRole('heading', { name: 'Understand your software system.' }),
    ).toBeTruthy();
  });

  it('renders not-found for removed auth routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );
    for (const path of ['/register', '/forgot-password', '/reset-password']) {
      cleanup();
      clearAuthSession();
      renderRoutes(path);
      expect(await screen.findByText('Page not found')).toBeTruthy();
    }
  });
});
