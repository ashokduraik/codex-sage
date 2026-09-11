/**
 * Unit tests for admin password-reset route edge outcomes.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../auth/password.service.js', () => ({
  adminSetPassword: vi.fn(),
}));
vi.mock('./membership.repository.js', () => ({
  findMembership: vi.fn(),
}));
vi.mock('./role.model.js', () => ({
  Role: { find: vi.fn() },
}));

import { adminSetPassword } from '../auth/password.service.js';
import { findMembership } from './membership.repository.js';
import { Role } from './role.model.js';
import { adminPasswordResetRoutes } from './adminPasswordReset.routes.js';

/**
 * @returns {{ authenticate: Function, post: Function, getHandler: Function }}
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

describe('adminPasswordReset.routes edge outcomes', () => {
  it('forbids when membership has no role ids', async () => {
    findMembership.mockResolvedValue({ roleIds: [] });
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
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('maps unexpected service outcome to INTERNAL_ERROR', async () => {
    findMembership.mockResolvedValue({ roleIds: ['r1'] });
    Role.find.mockReturnValue({
      exec: async () => [{ builtInKey: 'org_admin', permissions: [] }],
    });
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
});
