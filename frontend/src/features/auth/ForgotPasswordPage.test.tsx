import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import ForgotPasswordPage from '@/features/auth/ForgotPasswordPage';
import { clearAuthSession, renderWithProviders } from '@/test/renderWithProviders';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
  });

  it('shows success copy after submitting a reset request', async () => {
    renderWithProviders(<ForgotPasswordPage />, { route: '/forgot-password' });
    expect(screen.getByRole('heading', { name: 'Reset password' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'reset@acme.io' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(
      await screen.findByText(
        /If an account exists for that email, a reset link is on its way/i,
      ),
    ).toBeTruthy();
  });
});
