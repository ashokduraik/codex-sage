import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { AuthProvider } from '@/features/auth/AuthContext';
import { CURRENT_USER_QUERY_KEY } from '@/features/auth/api/authKeys.js';
import { setAccessToken } from '@/shared/api';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { queryClientInstance } from '@/shared/lib/query-client';
import { AppDataProvider } from '@/shared/mock-data';
import i18n from '@/shared/i18n';

/**
 * Builds a test AuthUser matching GET /auth/me.
 * @param {string} [email] Session email.
 * @param {object} [overrides] Field overrides.
 * @returns {object}
 */
export function buildTestAuthUser(email = 'you@acme.io', overrides = {}) {
  return {
    id: 'u_test',
    email,
    displayName: 'You',
    orgId: 'org_test',
    roleIds: ['role_admin'],
    permissions: ['users.manage'],
    mustChangePassword: false,
    ...overrides,
  };
}

/** @type {object | null} */
let seededAuthUser = null;

/**
 * Seed an in-memory authenticated session before render.
 * Pair with renderWithProviders so the current-user query is prefilled.
 *
 * @param {string} [email] Session email.
 * @param {object} [overrides] User field overrides.
 * @returns {object} Seeded user.
 */
export function seedAuthSession(email = 'you@acme.io', overrides = {}) {
  seededAuthUser = buildTestAuthUser(email, overrides);
  setAccessToken('test-access-token');
  queryClientInstance.setQueryData(CURRENT_USER_QUERY_KEY, seededAuthUser);
  return seededAuthUser;
}

/**
 * Clear the in-memory auth session and seeded user.
 */
export function clearAuthSession() {
  seededAuthUser = null;
  resetApiSessionForTests();
  queryClientInstance.removeQueries({ queryKey: CURRENT_USER_QUERY_KEY });
}

/**
 * Render a UI tree with router, i18n, query client, mock data, and auth providers.
 *
 * @param ui - Element to render
 * @param options - Route and render options (`routeState` is location.state)
 * @returns Testing Library render result
 */
export function renderWithProviders(ui, options = {}) {
  const {
    route = '/',
    routeState,
    withAuth = true,
    authUser,
    queryClient: providedQueryClient,
    ...renderOptions
  } = options;
  const queryClient =
    providedQueryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

  const resolvedUser = authUser !== undefined ? authUser : seededAuthUser;
  if (resolvedUser) {
    setAccessToken('test-access-token');
    queryClient.setQueryData(CURRENT_USER_QUERY_KEY, resolvedUser);
  }

  const parsedRoute = new URL(route, 'http://localhost');
  const initialEntry =
    routeState === undefined
      ? route
      : {
          pathname: parsedRoute.pathname,
          search: parsedRoute.search,
          hash: parsedRoute.hash,
          state: routeState,
        };

  function Wrapper({ children }) {
    return (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[initialEntry]}>
            {withAuth ? (
              <AuthProvider>
                <AppDataProvider>{children}</AppDataProvider>
              </AuthProvider>
            ) : (
              <AppDataProvider>{children}</AppDataProvider>
            )}
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...renderOptions });
}
