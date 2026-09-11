import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTH_STORAGE_KEY,
  AuthProvider,
  useAuth,
  type AuthUser,
} from '@/features/auth/AuthContext';
import {
  clearAuthSession,
  seedAuthSession,
} from '@/test/renderWithProviders';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/**
 * Render a hook under AuthProvider + MemoryRouter.
 */
function renderAuthHook(initialPath = '/') {
  return renderHook(() => useAuth(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>{children}</AuthProvider>
      </MemoryRouter>
    ),
  });
}

describe('AuthContext', () => {
  beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
  });

  it('logs in successfully and persists the session', async () => {
    const { result } = renderAuthHook();
    await act(async () => {
      await result.current.login('admin@acme.io', 'secret');
    });
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.email).toBe('admin@acme.io');
    expect(result.current.user?.role).toBe('admin');
    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}') as {
      user: AuthUser;
    };
    expect(stored.user.email).toBe('admin@acme.io');
  });

  it('rejects login when email or password is empty', async () => {
    const { result } = renderAuthHook();
    await expect(
      act(async () => {
        await result.current.login(' ', '');
      }),
    ).rejects.toThrow(/Email and password are required/);
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('registers then verifies OTP to establish a session', async () => {
    const { result } = renderAuthHook();
    await act(async () => {
      await result.current.register('new.user@acme.io', 'password', 'New User');
    });
    expect(result.current.pendingEmail).toBe('new.user@acme.io');
    expect(result.current.isAuthenticated).toBe(false);

    await act(async () => {
      await result.current.verifyOtp('123456');
    });
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.full_name).toBe('New User');
    expect(result.current.pendingEmail).toBeNull();
  });

  it('rejects verifyOtp without pending registration or invalid code', async () => {
    const { result } = renderAuthHook();
    await expect(
      act(async () => {
        await result.current.verifyOtp('123456');
      }),
    ).rejects.toThrow(/No pending registration/);

    await act(async () => {
      await result.current.register('otp@acme.io', 'password');
    });
    await expect(
      act(async () => {
        await result.current.verifyOtp('12');
      }),
    ).rejects.toThrow(/6-character/);
  });

  it('resends OTP when registration is pending and fails otherwise', async () => {
    const { result } = renderAuthHook();
    await expect(
      act(async () => {
        await result.current.resendOtp();
      }),
    ).rejects.toThrow(/No pending registration/);

    await act(async () => {
      await result.current.register('resend@acme.io', 'password');
    });
    expect(result.current.pendingEmail).toBe('resend@acme.io');
    await act(async () => {
      await result.current.resendOtp();
    });
    expect(result.current.pendingEmail).toBe('resend@acme.io');
  });

  it('accepts resetPasswordRequest for any email', async () => {
    const { result } = renderAuthHook();
    await act(async () => {
      await result.current.resetPasswordRequest('anyone@acme.io');
    });
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('resetPassword requires token and password', async () => {
    const { result } = renderAuthHook();
    await expect(
      act(async () => {
        await result.current.resetPassword('', 'newpass');
      }),
    ).rejects.toThrow(/Reset token is required/);
    await expect(
      act(async () => {
        await result.current.resetPassword('tok', '');
      }),
    ).rejects.toThrow(/Password is required/);
    await act(async () => {
      await result.current.resetPassword('tok', 'newpass');
    });
  });

  it('logs in with Google as a mock user', async () => {
    const { result } = renderAuthHook();
    await act(async () => {
      await result.current.loginWithGoogle();
    });
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.email).toBe('google.user@acme.io');
  });

  it('logs out and clears storage, optionally without redirect', async () => {
    seedAuthSession('you@acme.io');
    const { result } = renderAuthHook('/projects');
    expect(result.current.isAuthenticated).toBe(true);

    act(() => {
      result.current.logout(false);
    });
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('restores a wrapped session from localStorage on mount', async () => {
    seedAuthSession('restored@acme.io');
    const { result } = renderAuthHook();
    await waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
      expect(result.current.user?.email).toBe('restored@acme.io');
      expect(result.current.authChecked).toBe(true);
    });
  });

  it('restores a bare AuthUser payload from localStorage', () => {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        id: 'u_bare',
        email: 'bare@acme.io',
        full_name: 'Bare',
        role: 'user',
      }),
    );
    const { result } = renderAuthHook();
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.email).toBe('bare@acme.io');
  });

  it('throws when useAuth is called outside AuthProvider', () => {
    expect(() => renderHook(() => useAuth())).toThrow(
      /useAuth must be used within an AuthProvider/,
    );
  });

  it('rejects register when email or password is empty', async () => {
    const { result } = renderAuthHook();
    await expect(
      act(async () => {
        await result.current.register('', 'x');
      }),
    ).rejects.toThrow(/Email and password are required/);
  });

  it('ignores invalid stored session JSON', () => {
    localStorage.setItem(AUTH_STORAGE_KEY, '{not-json');
    const { result } = renderAuthHook();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });
});

describe('AuthProvider logout redirect', () => {
  beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
  });

  it('navigates to login when logout redirects', async () => {
    function Probe() {
      const auth = useAuth();
      return (
        <div>
          <span data-testid="auth-flag">{auth.isAuthenticated ? 'yes' : 'no'}</span>
          <button type="button" onClick={() => auth.logout()}>
            Logout
          </button>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('auth-flag').textContent).toBe('yes');
    await act(async () => {
      screen.getByRole('button', { name: 'Logout' }).click();
    });
    expect(screen.getByTestId('auth-flag').textContent).toBe('no');
  });
});
