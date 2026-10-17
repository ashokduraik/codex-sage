/**
 * In-app notification list and mark-read HTTP calls.
 */
import { apiRequest } from '@/shared/api';

/** Default list page size. */
export const NOTIFICATION_LIST_PAGE_SIZE = 20;

/**
 * @typedef {{
 *   id: string,
 *   type: string,
 *   title: string,
 *   body: string,
 *   resourceRef: { projectId: string | null, jobId: string | null, sourceVersionId: string | null },
 *   readAt: string | null,
 *   createdAt: string,
 * }} NotificationDto
 */

/**
 * Query key for the signed-in user's inbox.
 * @param {{ unreadOnly?: boolean }} [filters] List filters.
 * @returns {readonly unknown[]}
 */
export function notificationsQueryKey(filters = {}) {
  return Object.freeze(['notifications', { unreadOnly: filters.unreadOnly === true }]);
}

/**
 * Lists notifications for the caller.
 * @param {{
 *   unreadOnly?: boolean,
 *   cursor?: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} [options] List options.
 * @returns {Promise<{ items: NotificationDto[], nextCursor: string | null, unreadTotal: number }>}
 */
export async function listNotifications(options = {}) {
  const search = new URLSearchParams();
  if (options.unreadOnly) {
    search.set('unread', '1');
  }
  if (options.cursor) {
    search.set('cursor', options.cursor);
  }
  search.set('limit', String(options.limit ?? NOTIFICATION_LIST_PAGE_SIZE));
  return apiRequest(`/masters/notifications/list?${search.toString()}`, { signal: options.signal });
}

/**
 * Marks one notification read.
 * @param {{ notificationId: string, signal?: AbortSignal }} input Target.
 * @returns {Promise<{ id: string, readAt: string }>}
 */
export async function markNotificationRead(input) {
  return apiRequest(`/masters/notifications/markRead/${encodeURIComponent(input.notificationId)}`, {
    method: 'POST',
    signal: input.signal,
  });
}

/**
 * Marks all notifications read.
 * @param {{ signal?: AbortSignal }} [options] Optional abort.
 * @returns {Promise<{ updatedCount: number }>}
 */
export async function markAllNotificationsRead(options = {}) {
  return apiRequest('/masters/notifications/markAllRead', {
    method: 'POST',
    signal: options.signal,
  });
}
