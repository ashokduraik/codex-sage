/**
 * Notification route validation edges.
 */
import { describe, expect, it } from 'vitest';
import { notificationRoutes } from '../../../src/modules/masters/notifications.js';

/**
 * @returns {{ handlers: Map<string, Function>, get: Function, post: Function }}
 */
function createFakeApp() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  return {
    handlers,
    get(path, _opts, handler) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path, _opts, handler) {
      handlers.set(`POST ${path}`, handler);
    },
  };
}

describe('notification.routes unit edges', () => {
  it('rejects an invalid list query and empty read params', async () => {
    const app = createFakeApp();
    await notificationRoutes(/** @type {any} */ (app));
    await expect(
      app.handlers.get('GET /notifications')({
        query: { limit: 'nope' },
        principal: { orgId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439012' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      app.handlers.get('POST /notifications/:notificationId/read')({
        params: { notificationId: '' },
        principal: { orgId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439012' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
