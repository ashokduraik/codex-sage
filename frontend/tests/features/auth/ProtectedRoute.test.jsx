import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProtectedRoute from '@/features/auth/ProtectedRoute';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@tests/renderWithProviders';

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

describe('ProtectedRoute', () => {
  beforeEach(() => {
    clearAuthSession();
    resetRefreshClientForTests();
  });

  it('renders the fallback while auth is unresolved and no protected child', async () => {
    let resolveRefresh;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        if (String(url).endsWith('/auth/refresh')) {
          await refreshPromise;
          return jsonResponse({
            status: 401,
            body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
          });
        }
        return jsonResponse({
          status: 500,
          body: { error: { code: 'UNEXPECTED', message: 'x' } },
        });
      }),
    );

    renderWithProviders(
      <Routes>
        <Route
          element={
            <ProtectedRoute
              fallback={<div data-testid="fallback">loading</div>}
              unauthenticatedElement={<div data-testid="signed-out">out</div>}
            />
          }
        >
          <Route path="/" element={<div data-testid="protected">in</div>} />
        </Route>
      </Routes>,
      { route: '/' },
    );

    expect(screen.getByTestId('fallback')).toBeTruthy();
    expect(screen.queryByTestId('protected')).toBeNull();
    resolveRefresh();
    expect(await screen.findByTestId('signed-out')).toBeTruthy();
  });

  it('renders the unauthenticated element when the session is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );

    renderWithProviders(
      <Routes>
        <Route
          element={
            <ProtectedRoute unauthenticatedElement={<div data-testid="signed-out">out</div>} />
          }
        >
          <Route path="/" element={<div data-testid="protected">in</div>} />
        </Route>
      </Routes>,
      { route: '/' },
    );

    expect(await screen.findByTestId('signed-out')).toBeTruthy();
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  it('renders the outlet once the session resolves', async () => {
    seedAuthSession('you@acme.io');
    renderWithProviders(
      <Routes>
        <Route element={<ProtectedRoute unauthenticatedElement={<div>out</div>} />}>
          <Route path="/" element={<div data-testid="protected">in</div>} />
        </Route>
      </Routes>,
      { route: '/' },
    );

    expect(await screen.findByTestId('protected')).toBeTruthy();
  });

  it('redirects to change-password when mustChangePassword is true', async () => {
    seedAuthSession('you@acme.io', { mustChangePassword: true });
    renderWithProviders(
      <Routes>
        <Route element={<ProtectedRoute unauthenticatedElement={<div>out</div>} />}>
          <Route path="/" element={<div data-testid="protected">in</div>} />
          <Route path="/change-password" element={<div data-testid="change">change</div>} />
        </Route>
      </Routes>,
      { route: '/' },
    );

    expect(await screen.findByTestId('change')).toBeTruthy();
    expect(screen.queryByTestId('protected')).toBeNull();
  });

  it('uses the default LoginRedirect when unauthenticated without a custom element', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );

    renderWithProviders(
      <Routes>
        <Route path="/login" element={<div data-testid="login">login</div>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/projects" element={<div data-testid="protected">in</div>} />
        </Route>
      </Routes>,
      { route: '/projects' },
    );

    expect(await screen.findByTestId('login')).toBeTruthy();
  });
});
