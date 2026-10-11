import { setAccessToken } from '@/shared/api/index';
import { act, renderHook } from '@testing-library/react';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ADMIN_ROLES_QUERY_KEY } from '@/features/admin/api/adminIdentityApi.js';
import { useCreateRole, useDeleteRole, useUpdateRole } from '@/features/admin/api/useRoleMutations.js';

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

/**
 * @param {object} body JSON body.
 * @param {number} [status]
 */
function jsonFetch(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
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
}

describe('useRoleMutations', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    setAccessToken('tok');
  });

  it('createRole invalidates the roles list on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonFetch({ id: 'r1', code: 'READER', name: 'Reader', permissions: ['chat.ask'] }, 201)));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateRole(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        code: 'READER',
        name: 'Reader',
        permissions: ['chat.ask'],
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ADMIN_ROLES_QUERY_KEY,
    });
  });

  it('updateRole and deleteRole invalidate the roles list', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonFetch({ id: 'r1', name: 'X' }))
        .mockResolvedValueOnce({
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
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const update = renderHook(() => useUpdateRole(), {
      wrapper: createWrapper(queryClient),
    });
    const remove = renderHook(() => useDeleteRole(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await update.result.current.mutateAsync({ roleId: 'r1', name: 'X' });
      await remove.result.current.mutateAsync({ roleId: 'r1' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ADMIN_ROLES_QUERY_KEY,
    });
  });
});
