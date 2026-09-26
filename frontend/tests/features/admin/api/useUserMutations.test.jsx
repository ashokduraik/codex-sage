import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '@/shared/api/index';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { useCreateUser, useResetUserPassword, useSetUserStatus, useUpdateUserRoles } from '@/features/admin/api/useUserMutations.js';
import { adminUsersQueryKey } from '@/features/admin/api/adminIdentityApi.js';
import { ApiError } from '@/shared/api/index';

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

describe('useUserMutations', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    setAccessToken('tok');
  });

  it('createUser invalidates the users list on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonFetch({ id: 'u9', email: 'n@b.co', displayName: 'N', roles: [] }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useCreateUser(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        code: 'N1',
        email: 'n@b.co',
        displayName: 'N',
        roleIds: ['r1'],
        idempotencyKey: 'k1',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['admin', 'users'],
    });
  });

  it('updateUserRoles rolls back optimistic roles on 403', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const key = adminUsersQueryKey({});
    queryClient.setQueryData(key, {
      items: [
        {
          id: 'u1',
          displayName: 'A',
          email: 'a@b.co',
          roles: [{ id: 'r1', name: 'Viewer' }],
        },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonFetch(
          {
            error: {
              code: 'FORBIDDEN',
              message: 'Not allowed.',
            },
          },
          403,
        ),
      ),
    );

    const { result } = renderHook(() => useUpdateUserRoles(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      try {
        await result.current.mutateAsync({
          userId: 'u1',
          roleIds: ['r2'],
          roles: [{ id: 'r2', name: 'Member' }],
        });
      } catch {
        // expected
      }
    });

    await waitFor(() => {
      const page = queryClient.getQueryData(key);
      expect(page.items[0].roles[0].id).toBe('r1');
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.status).toBe(403);
  });

  it('setUserStatus optimistically flips status', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const key = adminUsersQueryKey({});
    queryClient.setQueryData(key, {
      items: [{ id: 'u1', userStatus: 'active', roles: [] }],
      pageInfo: { nextCursor: null, hasMore: false },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonFetch({ id: 'u1', userStatus: 'disabled', roles: [] })),
    );

    const { result } = renderHook(() => useSetUserStatus(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ userId: 'u1', action: 'deactivate' });
    });

    await waitFor(() => {
      expect(queryClient.getQueryData(key).items[0].userStatus).toBe('disabled');
    });
  });

  it('setUserStatus activates a user', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const key = adminUsersQueryKey({});
    queryClient.setQueryData(key, {
      items: [{ id: 'u1', userStatus: 'disabled', roles: [] }],
      pageInfo: { nextCursor: null, hasMore: false },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonFetch({ id: 'u1', userStatus: 'active', roles: [] })),
    );

    const { result } = renderHook(() => useSetUserStatus(), {
      wrapper: createWrapper(queryClient),
    });

    act(() => {
      result.current.mutate({ userId: 'u1', action: 'activate' });
    });

    await waitFor(() => {
      expect(queryClient.getQueryData(key).items[0].userStatus).toBe('active');
    });
  });

  it('resetUserPassword does not put newPassword into mutation data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonFetch({ passwordResetStatus: 'completed' })),
    );
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { result } = renderHook(() => useResetUserPassword(), {
      wrapper: createWrapper(queryClient),
    });

    let response;
    await act(async () => {
      response = await result.current.mutateAsync({
        userId: 'u1',
        newPassword: 'NeverCacheThis1!',
        idempotencyKey: 'k',
      });
    });

    expect(response).toEqual({ passwordResetStatus: 'completed' });
    expect(JSON.stringify(response)).not.toContain('NeverCacheThis1!');
  });

  it('updateUserRoles skips non-list cache entries during optimistic patch', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const key = adminUsersQueryKey({});
    queryClient.setQueryData(key, {
      items: [
        {
          id: 'u1',
          displayName: 'A',
          email: 'a@b.co',
          roles: [{ id: 'r1', name: 'Viewer' }],
        },
        {
          id: 'u2',
          displayName: 'B',
          email: 'b@b.co',
          roles: [{ id: 'r1', name: 'Viewer' }],
        },
      ],
      pageInfo: { nextCursor: null, hasMore: false },
    });
    queryClient.setQueryData(adminUsersQueryKey({ q: 'null-page' }), null);
    queryClient.setQueryData(adminUsersQueryKey({ q: 'bad' }), { items: 'nope' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonFetch(
          {
            error: { code: 'FORBIDDEN', message: 'Nope.' },
          },
          403,
        ),
      ),
    );

    const { result } = renderHook(() => useUpdateUserRoles(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      try {
        await result.current.mutateAsync({
          userId: 'u1',
          roleIds: ['r2'],
          roles: [{ id: 'r2', name: 'Member' }],
        });
      } catch {
        // expected
      }
    });

    expect(queryClient.getQueryData(key).items[0].roles[0].id).toBe('r1');
    expect(queryClient.getQueryData(key).items[1].roles[0].id).toBe('r1');
  });
});
