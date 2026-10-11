import { setAccessToken } from '@/shared/api/index';
import { useUsers } from '@/features/admin/api/useUsers.js';
import { renderHook, waitFor } from '@testing-library/react';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
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

describe('useUsers', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    setAccessToken('tok');
  });

  it('refetches when the cursor changes and keeps the previous page while loading', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        jsonFetch({
          items: [{ id: 'u1', displayName: 'A', email: 'a@b.co', roles: [] }],
          pageInfo: { nextCursor: 'n1', hasMore: true },
        }),
      )
      .mockResolvedValueOnce(
        jsonFetch({
          items: [{ id: 'u2', displayName: 'B', email: 'b@b.co', roles: [] }],
          pageInfo: { nextCursor: null, hasMore: false },
        }),
      );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result, rerender } = renderHook(({ filters }) => useUsers(filters), {
      initialProps: { filters: { q: 'a' } },
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0].id).toBe('u1');

    rerender({ filters: { q: 'a', cursor: 'n1' } });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data?.items[0].id).toBe('u1');
    await waitFor(() => expect(result.current.data?.items[0].id).toBe('u2'));
  });

  it('includes q, userStatus, and roleId in the request URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonFetch({ items: [], pageInfo: { nextCursor: null, hasMore: false } }));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    renderHook(
      () =>
        useUsers({
          q: 'pri',
          userStatus: 'active',
          roleId: '507f1f77bcf86cd799439011',
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('q=pri');
    expect(url).toContain('userStatus=active');
    expect(url).toContain('roleId=507f1f77bcf86cd799439011');
  });
});
