import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';

import { AuthProvider } from '@/features/auth/AuthContext';
import { AppDataProvider } from '@/shared/mock-data';
import i18n from '@/shared/i18n';

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial MemoryRouter entries. */
  route?: string;
  /** Whether to wrap with AuthProvider (default true). */
  withAuth?: boolean;
}

/**
 * Render a UI tree with router, i18n, query client, mock data, and auth providers.
 *
 * @param ui - Element to render
 * @param options - Route and render options
 * @returns Testing Library render result
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): ReturnType<typeof render> {
  const { route = '/', withAuth = true, ...renderOptions } = options;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <AppDataProvider>
            <MemoryRouter initialEntries={[route]}>
              {withAuth ? <AuthProvider>{children}</AuthProvider> : children}
            </MemoryRouter>
          </AppDataProvider>
        </QueryClientProvider>
      </I18nextProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...renderOptions });
}

/**
 * Seed a mock authenticated session in localStorage before render.
 *
 * @param email - Session email
 */
export function seedAuthSession(email = 'you@acme.io'): void {
  localStorage.setItem(
    'codex-sage-auth',
    JSON.stringify({
      user: {
        id: 'u_test',
        email,
        full_name: 'You',
        role: 'admin',
      },
    }),
  );
}

/**
 * Clear mock auth session storage.
 */
export function clearAuthSession(): void {
  localStorage.removeItem('codex-sage-auth');
}
