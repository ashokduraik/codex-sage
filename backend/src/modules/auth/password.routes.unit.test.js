/**
 * Unit tests for password change route edge outcomes.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./password.service.js', () => ({
  changeOwnPassword: vi.fn(),
}));

import { changeOwnPassword } from './password.service.js';
import { passwordRoutes } from './password.routes.js';

/**
 * Builds a minimal Fastify-like app that captures the registered handler.
 * @returns {{ authenticate: Function, post: Function, handler: Function | null }}
 */
function createFakeApp() {
  /** @type {((request: object) => Promise<unknown>) | null} */
  let handler = null;
  return {
    authenticate: async () => {},
    /**
     * @param {string} _path
     * @param {object} _opts
     * @param {(request: object) => Promise<unknown>} routeHandler
     */
    post(_path, _opts, routeHandler) {
      handler = routeHandler;
    },
    getHandler() {
      return handler;
    },
  };
}

describe('password.routes edge outcomes', () => {
  it('maps not_found outcome to UNAUTHENTICATED', async () => {
    changeOwnPassword.mockResolvedValue({ outcome: 'not_found' });
    const app = createFakeApp();
    await passwordRoutes(/** @type {any} */ (app));
    const handler = app.getHandler();
    await expect(
      handler({
        body: { currentPassword: 'abcdef', newPassword: 'ghijkl' },
        principal: { orgId: 'o1', userId: 'u1' },
        log: { info: () => {} },
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('maps policy_violation without violations array', async () => {
    changeOwnPassword.mockResolvedValue({ outcome: 'policy_violation' });
    const app = createFakeApp();
    await passwordRoutes(/** @type {any} */ (app));
    const handler = app.getHandler();
    await expect(
      handler({
        body: { currentPassword: 'abcdef', newPassword: 'ghijkl' },
        principal: { orgId: 'o1', userId: 'u1' },
        log: { info: () => {} },
      }),
    ).rejects.toMatchObject({
      code: 'PASSWORD_POLICY_VIOLATION',
      details: { violations: [] },
    });
  });
});
