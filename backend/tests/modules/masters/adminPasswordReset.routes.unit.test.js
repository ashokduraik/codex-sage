/**
 * Unit tests for admin password-reset route edge outcomes.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/modules/access/index.js', () => ({
  adminSetPassword: vi.fn(),
  getPasswordResetStatus: vi.fn(() => ({ state: 'none', completedAt: null })),
  buildAuditContextFromRequest: vi.fn(() => ({
    correlationId: 'corr-1',
    ip: undefined,
    userAgent: undefined,
  })),
  recordAuditEvent: vi.fn(async () => {}),
  revokeAllLoginSessionsForUser: vi.fn(async () => ({})),
  PASSWORD_MIN_LENGTH: 6,
}));

import { userRoutes } from '../../../src/modules/masters/users.js';
import { adminSetPassword } from '../../../src/modules/access/index.js';

/**
 * @returns {{
 *   post: Function,
 *   get: Function,
 *   patch: Function,
 *   put: Function,
 *   delete: Function,
 *   getResetHandler: Function,
 *   getResetConfig: Function,
 * }}
 */
function createFakeApp() {
  /** @type {((request: object, reply?: object) => Promise<unknown>) | null} */
  let resetHandler = null;
  /** @type {object | null} */
  let resetConfig = null;

  /**
   * @param {string} method
   * @returns {(path: string, opts: object, routeHandler: Function) => void}
   */
  function register(method) {
    return (path, opts, routeHandler) => {
      if (method === 'post' && path === '/users/:userId/reset-password') {
        resetConfig = opts.config;
        resetHandler = routeHandler;
      }
    };
  }

  return {
    post: register('post'),
    get: register('get'),
    patch: register('patch'),
    put: register('put'),
    delete: register('delete'),
    getResetHandler() {
      return resetHandler;
    },
    getResetConfig() {
      return resetConfig;
    },
  };
}

describe('adminPasswordReset.routes edge outcomes', () => {
  it('declares users.manage for the global authorize hook', async () => {
    const app = createFakeApp();
    await userRoutes(/** @type {any} */ (app));
    expect(app.getResetConfig()).toEqual(
      expect.objectContaining({
        requiredPermissions: ['users.manage'],
      }),
    );
  });

  it('maps unexpected service outcome to INTERNAL_ERROR', async () => {
    adminSetPassword.mockResolvedValue({ outcome: 'password_changed' });
    const app = createFakeApp();
    await userRoutes(/** @type {any} */ (app));
    const handler = app.getResetHandler();
    await expect(
      handler({
        principal: { orgId: 'o1', userId: 'u1' },
        params: { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
        body: { newPassword: 'abcdef' },
        log: {},
        id: 'corr-1',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('rejects empty userId with VALIDATION_ERROR', async () => {
    const app = createFakeApp();
    await userRoutes(/** @type {any} */ (app));
    const handler = app.getResetHandler();
    await expect(
      handler({
        principal: { orgId: 'o1', userId: 'u1' },
        params: { userId: '' },
        body: { newPassword: 'abcdef' },
        log: {},
        id: 'corr-1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
