/**
 * Notification route validation edges.
 */
import { describe, expect, it } from 'vitest';
import { listNotificationsHttp, markNotificationReadHttp } from '../../../src/modules/masters/notifications.js';

describe('notification.routes unit edges', () => {
  it('rejects an invalid list query and empty read params', async () => {
    await expect(
      listNotificationsHttp({
        query: { limit: 'nope' },
        principal: { orgId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439012' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      markNotificationReadHttp({
        params: { notificationId: '' },
        principal: { orgId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439012' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
