/**
 * Debounced conversation search hook.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/features/chat/api/conversationsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    searchConversations: vi.fn(),
  };
});

import { searchConversations } from '@/features/chat/api/conversationsApi.js';
import { useConversationSearch, flattenSearchPages } from '@/features/chat/hooks/useConversationSearch.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  searchConversations.mockReset();
  vi.useRealTimers();
});

describe('useConversationSearch', () => {
  it('does not search when q is empty and flattens empty data', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useConversationSearch('p1', { q: '   ', debounceMs: 10 }), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(searchConversations).not.toHaveBeenCalled();
    expect(flattenSearchPages(undefined)).toEqual([]);
    expect(result.current.hits).toEqual([]);
  });

  it('debounces and returns search hits', async () => {
    searchConversations.mockResolvedValue({
      items: [{ id: 'c1', title: 'Auth', snippet: 'login', updatedAt: '2026-01-01T00:00:00Z' }],
      nextCursor: null,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useConversationSearch('p1', { q: 'auth', debounceMs: 10 }), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.hits).toHaveLength(1);
    expect(searchConversations).toHaveBeenCalled();
  });

  it('pages search results via nextCursor and flattens sparse pages', async () => {
    searchConversations
      .mockResolvedValueOnce({
        items: [{ id: 'c1', title: 'Auth', snippet: 'a', updatedAt: '2026-01-01T00:00:00Z' }],
        nextCursor: 'n2',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'c2', title: 'Pay', snippet: 'b', updatedAt: '2026-01-02T00:00:00Z' }],
        nextCursor: null,
      });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useConversationSearch('p1', { q: 'a', archived: true, debounceMs: 10 }), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    await act(async () => {
      await result.current.query.fetchNextPage();
    });
    await waitFor(() => expect(result.current.hits).toHaveLength(2));
    expect(flattenSearchPages({ pages: [{ items: null }, { items: [{ id: 'x' }] }] })).toEqual([{ id: 'x' }]);
  });
});
