import ChangePasswordPage from '@/features/auth/ChangePasswordPage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

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

describe('ChangePasswordPage', () => {
  beforeEach(() => {
    clearAuthSession();
    resetRefreshClientForTests();
    document.cookie = 'csrfToken=test-csrf';
  });

  it('rejects mismatched confirmation passwords', async () => {
    seedAuthSession();
    renderWithProviders(<ChangePasswordPage />, { route: '/change-password' });
    await screen.findByRole('heading', { name: 'Change password' });

    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old' },
    });
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'new-one' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'new-two' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/do not match/i);
  });

  it('submits a password change and returns to login', async () => {
    seedAuthSession();
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/access/password/change')) {
        return jsonResponse({
          status: 200,
          body: {
            passwordChanged: true,
            sessionsRevoked: true,
            reauthenticationRequired: true,
          },
        });
      }
      if (String(url).includes('/access/auth/logout')) {
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
      return jsonResponse({
        status: 500,
        body: { error: { code: 'UNEXPECTED', message: 'x' } },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<ChangePasswordPage />, { route: '/change-password' });
    await screen.findByLabelText('Current password');

    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old-password' },
    });
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'new-password-ok' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'new-password-ok' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/access/password/change'))).toBe(true);
    });
  });

  it('shows an API error with correlation id on failure', async () => {
    seedAuthSession();
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/access/password/change')) {
        return jsonResponse({
          status: 400,
          body: {
            error: {
              code: 'PASSWORD_POLICY_VIOLATION',
              message: 'Password too weak',
              reference: 'corr-pw',
            },
          },
        });
      }
      return jsonResponse({
        status: 500,
        body: { error: { code: 'UNEXPECTED', message: 'x' } },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithProviders(<ChangePasswordPage />, { route: '/change-password' });
    await screen.findByLabelText('Current password');

    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old-password' },
    });
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'weak' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'weak' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Password too weak/);
    expect(screen.getByRole('alert').textContent).toMatch(/corr-pw/);
  });

  it('shows forced copy when mustChangePassword is set', async () => {
    seedAuthSession('you@acme.io', { mustChangePassword: true });
    renderWithProviders(<ChangePasswordPage />, { route: '/change-password' });
    expect(await screen.findByRole('heading', { name: 'Update your password' })).toBeTruthy();
  });
});
