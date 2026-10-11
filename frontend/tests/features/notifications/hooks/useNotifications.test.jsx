/**
 * Inbox query and mark-read mutation hooks.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/features/notifications/api/notificationsApi.js', () => ({
  notificationsQueryKey: (filters = {}) => Object.freeze(['notifications', { unreadOnly: filters.unreadOnly === true }]),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

import { useNotificationActions, useNotifications } from '@/features/notifications/hooks/useNotifications.js';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '@/features/notifications/api/notificationsApi.js';

/**
 * @param {import('@tanstack/react-query').QueryClient} queryClient Client.
 */
function createWrapper(queryClient) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useNotifications', () => {
  it('loads the inbox and skips when disabled', async () => {
    listNotifications.mockResolvedValue({ items: [], nextCursor: null, unreadTotal: 0 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result: disabled } = renderHook(() => useNotifications({ enabled: false }), {
      wrapper: createWrapper(queryClient),
    });
    expect(disabled.current.fetchStatus).toBe('idle');

    const { result } = renderHook(() => useNotifications(), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listNotifications).toHaveBeenCalled();
  });
});

describe('useNotificationActions', () => {
  it('invalidates the inbox after mark-read mutations', async () => {
    markNotificationRead.mockResolvedValue({ id: 'n1', readAt: '2026-09-26T00:00:00.000Z' });
    markAllNotificationsRead.mockResolvedValue({ updatedCount: 1 });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useNotificationActions(), {
      wrapper: createWrapper(queryClient),
    });
    await act(async () => {
      await result.current.markRead('n1');
      await result.current.markAllRead();
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['notifications'] });
  });
});
