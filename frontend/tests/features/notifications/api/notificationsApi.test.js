/**
 * Notification HTTP client tests.
 */
import { API_BASE_URL, setAccessToken } from '@/shared/api/index';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import {
  listNotifications,
  markNotificationRead,
  notificationsQueryKey,
  markAllNotificationsRead,
} from '@/features/notifications/api/notificationsApi.js';

/**
 * @param {{ status: number, body: object }} options Response.
 * @returns {object}
 */
function jsonResponse({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
    clone() {
      return jsonResponse({ status, body });
    },
  };
}

describe('notificationsApi', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    resetRefreshClientForTests();
    setAccessToken('tok');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiSessionForTests();
    resetRefreshClientForTests();
  });

  it('lists with unread, cursor, and limit query params', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: { items: [], nextCursor: null, unreadTotal: 0 },
      }),
    );
    await listNotifications({ unreadOnly: true, cursor: 'cur1', limit: 10 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith(`${API_BASE_URL}/masters/notifications/list?`)).toBe(true);
    expect(url).toContain('unread=1');
    expect(url).toContain('cursor=cur1');
    expect(url).toContain('limit=10');
    expect(notificationsQueryKey({ unreadOnly: true })).toEqual(['notifications', { unreadOnly: true }]);
  });

  it('marks one notification and all as read', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: 200, body: { id: 'n1', readAt: '2026-09-26T00:00:00.000Z' } }))
      .mockResolvedValueOnce(jsonResponse({ status: 200, body: { updatedCount: 2 } }));
    await expect(markNotificationRead({ notificationId: 'n1' })).resolves.toEqual({
      id: 'n1',
      readAt: '2026-09-26T00:00:00.000Z',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/masters/notifications/markRead/n1');
    await expect(markAllNotificationsRead()).resolves.toEqual({ updatedCount: 2 });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/masters/notifications/markAllRead');
  });
});
