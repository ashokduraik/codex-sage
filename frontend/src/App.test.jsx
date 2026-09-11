import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/shared/i18n';
import { App } from './App';
import { getAccessToken } from '@/shared/api';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import { clearAuthSession, seedAuthSession } from '@/test/renderWithProviders';

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

describe('App', () => {
  beforeEach(() => {
    clearAuthSession();
    resetRefreshClientForTests();
    window.history.pushState({}, '', '/');
  });

  it('redirects unauthenticated users to the login page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        }),
      ),
    );
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
  });

  it('renders the home hero when a session is seeded', async () => {
    seedAuthSession('you@acme.io');
    expect(getAccessToken()).toBe('test-access-token');
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Understand your software system.' }),
    ).toBeTruthy();
  });
});
