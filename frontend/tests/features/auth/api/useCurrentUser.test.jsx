import { setAccessToken } from '@/shared/api/index';
import { renderHook, waitFor } from '@testing-library/react';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { useCurrentUser } from '@/features/auth/api/useCurrentUser.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

afterEach(() => {
  resetApiSessionForTests();
  vi.unstubAllGlobals();
});

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 */
function createWrapper(queryClient) {
  /**
   * @param {{ children: import('react').ReactNode }} props
   */
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useCurrentUser', () => {
  beforeEach(() => {
    resetApiSessionForTests();
  });

  it('stays disabled when enabled is false', () => {
    setAccessToken('tok');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useCurrentUser({ enabled: false }), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.isFetching).toBe(false);
  });

  it('fetches when enabled and a token is present', async () => {
    setAccessToken('tok');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() {
          return JSON.stringify({
            id: 'u1',
            email: 'a@b.co',
            displayName: 'A',
            orgId: 'o1',
            roleIds: [],
            permissions: [],
            mustChangePassword: false,
          });
        },
        async json() {
          return {};
        },
        clone() {
          return this;
        },
      })),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useCurrentUser({ enabled: true }), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.email).toBe('a@b.co');
  });
});
