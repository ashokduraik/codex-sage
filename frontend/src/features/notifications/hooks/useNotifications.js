/**
 * React Query hooks for the in-app notification inbox.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listNotifications, markAllNotificationsRead, markNotificationRead, notificationsQueryKey } from '../api/notificationsApi.js';

/** Inbox refetch interval while the header is mounted. */
export const NOTIFICATION_POLL_INTERVAL_MS = 30_000;

/**
 * Loads the caller's notifications.
 * @param {{ unreadOnly?: boolean, enabled?: boolean }} [options] Query options.
 * @returns {import('@tanstack/react-query').UseQueryResult}
 */
export function useNotifications(options = {}) {
  return useQuery({
    queryKey: notificationsQueryKey({ unreadOnly: options.unreadOnly }),
    queryFn: ({ signal }) => listNotifications({ unreadOnly: options.unreadOnly, signal }),
    enabled: options.enabled !== false,
    refetchInterval: NOTIFICATION_POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
}

/**
 * Mark-read mutations that invalidate the inbox.
 * @returns {{
 *   markRead: (notificationId: string) => Promise<unknown>,
 *   markAllRead: () => Promise<unknown>,
 *   isMarking: boolean,
 * }}
 */
export function useNotificationActions() {
  const queryClient = useQueryClient();

  const markOne = useMutation({
    mutationFn: (notificationId) => markNotificationRead({ notificationId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
  const markAll = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  return {
    markRead: (notificationId) => markOne.mutateAsync(notificationId),
    markAllRead: () => markAll.mutateAsync(),
    isMarking: markOne.isPending || markAll.isPending,
  };
}
