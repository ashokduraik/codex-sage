/**
 * Message infinite query auto-fetch behavior.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/features/chat/api/conversationsApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listConversationMessages: vi.fn(),
  };
});

import { listConversationMessages } from '@/features/chat/api/conversationsApi.js';
import { useConversationMessages, flattenMessagePages } from '@/features/chat/hooks/useConversationMessages.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  listConversationMessages.mockReset();
});

describe('useConversationMessages', () => {
  it('auto-fetches until nextCursor is null and flattens pages', async () => {
    listConversationMessages
      .mockResolvedValueOnce({
        items: [{ id: 'm1', role: 'user', content: 'a', messageStatus: 'completed', createdAt: '2026-01-01T00:00:00Z' }],
        nextCursor: 'c2',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'm2', role: 'assistant', content: 'b', messageStatus: 'completed', createdAt: '2026-01-01T00:01:00Z' }],
        nextCursor: null,
      });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useConversationMessages('p1', 'c1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(flattenMessagePages(result.current.data)).toHaveLength(2);
    expect(listConversationMessages).toHaveBeenCalledTimes(2);
  });

  it('stops auto-fetch at maxAutoFetchPages', async () => {
    listConversationMessages.mockResolvedValue({
      items: [{ id: 'm1', role: 'user', content: 'a', messageStatus: 'completed', createdAt: '2026-01-01T00:00:00Z' }],
      nextCursor: 'more',
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useConversationMessages('p1', 'c1', { maxAutoFetchPages: 1 }), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(listConversationMessages.mock.calls.length).toBe(1));
    expect(result.current.hasNextPage).toBe(true);
  });

  it('returns empty flatten for missing data', () => {
    expect(flattenMessagePages(undefined)).toEqual([]);
  });
});
