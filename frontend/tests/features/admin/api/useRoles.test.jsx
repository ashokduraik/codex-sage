import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '@/shared/api/index';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { usePermissionsCatalog } from '@/features/admin/api/usePermissionsCatalog.js';
import { useRoles } from '@/features/admin/api/useRoles.js';

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
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('useRoles and usePermissionsCatalog', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    setAccessToken('tok');
  });

  it('loads aggregated roles and the permissions catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const path = String(url);
        const body = path.includes('/permissions')
          ? { groups: [{ id: 'org', label: 'Organization', permissions: [] }] }
          : {
              items: [{ id: 'r1', name: 'Viewer', permissions: [] }],
              pageInfo: { nextCursor: null, hasMore: false },
            };
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          async text() {
            return JSON.stringify(body);
          },
          async json() {
            return body;
          },
          clone() {
            return this;
          },
        };
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const roles = renderHook(() => useRoles(), {
      wrapper: createWrapper(queryClient),
    });
    const catalog = renderHook(() => usePermissionsCatalog(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(roles.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(catalog.result.current.isSuccess).toBe(true));
    expect(roles.result.current.data[0].name).toBe('Viewer');
    expect(catalog.result.current.data.groups[0].id).toBe('org');
  });

  it('stays idle when enabled is false', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useRoles({ enabled: false }), {
      wrapper: createWrapper(queryClient),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });
});
