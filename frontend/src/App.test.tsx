import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@/shared/i18n';
import { App } from './App';
import { AUTH_STORAGE_KEY } from '@/features/auth/AuthContext';
import { clearAuthSession, seedAuthSession } from '@/test/renderWithProviders';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('App', () => {
  beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    window.history.pushState({}, '', '/');
  });

  it('redirects unauthenticated users to the login page', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
  });

  it('renders the home hero when a session is seeded', async () => {
    seedAuthSession('you@acme.io');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeTruthy();
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Understand your software system.' }),
    ).toBeTruthy();
  });
});
