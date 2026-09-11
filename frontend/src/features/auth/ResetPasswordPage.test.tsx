import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ResetPasswordPage from '@/features/auth/ResetPasswordPage';
import { clearAuthSession, renderWithProviders } from '@/test/renderWithProviders';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
  });

  it('shows invalid-link UI when the token query param is missing', () => {
    renderWithProviders(<ResetPasswordPage />, { route: '/reset-password' });
    expect(screen.getByRole('heading', { name: 'Invalid reset link' })).toBeTruthy();
    expect(screen.getByText(/incomplete/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Request a new link/i })).toBeTruthy();
  });

  it('resets the password successfully when a token is present', async () => {
    const toastSuccess = vi.spyOn(toast, 'success').mockImplementation(() => '');

    renderWithProviders(<ResetPasswordPage />, {
      route: '/reset-password?token=reset-tok-1',
    });

    expect(screen.getByRole('heading', { name: 'New password' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'brand-new-pass' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'brand-new-pass' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });
  });

  it('shows a mismatch error when confirmation differs', async () => {
    renderWithProviders(<ResetPasswordPage />, {
      route: '/reset-password?token=reset-tok-2',
    });

    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'brand-new-pass' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'other-pass' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
