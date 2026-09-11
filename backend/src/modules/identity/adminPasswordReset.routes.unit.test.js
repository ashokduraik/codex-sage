/**
 * Unit tests for admin password-reset route edge outcomes.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../auth/password.service.js', () => ({
  adminSetPassword: vi.fn(),
}));

import { adminSetPassword } from '../auth/password.service.js';
import { adminPasswordResetRoutes } from './adminPasswordReset.routes.js';

/**
 * @returns {{ post: Function, getHandler: Function, getConfig: Function }}
 */
function createFakeApp() {
  /** @type {((request: object) => Promise<unknown>) | null} */
  let handler = null;
  /** @type {object | null} */
  let config = null;
  return {
    /**
     * @param {string} _path
     * @param {object} opts
     * @param {(request: object) => Promise<unknown>} routeHandler
     */
    post(_path, opts, routeHandler) {
      config = opts.config;
      handler = routeHandler;
    },
    getHandler() {
      return handler;
    },
    getConfig() {
      return config;
    },
  };
}

describe('adminPasswordReset.routes edge outcomes', () => {
  it('declares users.manage for the global authorize hook', async () => {
    const app = createFakeApp();
    await adminPasswordResetRoutes(/** @type {any} */ (app));
    expect(app.getConfig()).toEqual(
      expect.objectContaining({
        requiredPermissions: ['users.manage'],
      }),
    );
  });

  it('maps unexpected service outcome to INTERNAL_ERROR', async () => {
    adminSetPassword.mockResolvedValue({ outcome: 'password_changed' });
    const app = createFakeApp();
    await adminPasswordResetRoutes(/** @type {any} */ (app));
    const handler = app.getHandler();
    await expect(
      handler({
        principal: { orgId: 'o1', userId: 'u1' },
        params: { userId: 'u2' },
        body: { newPassword: 'abcdef' },
        log: {},
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('rejects empty userId with VALIDATION_ERROR', async () => {
    const app = createFakeApp();
    await adminPasswordResetRoutes(/** @type {any} */ (app));
    const handler = app.getHandler();
    await expect(
      handler({
        principal: { orgId: 'o1', userId: 'u1' },
        params: { userId: '' },
        body: { newPassword: 'abcdef' },
        log: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
