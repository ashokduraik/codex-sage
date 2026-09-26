/**
 * Usage route validation edges.
 */
import { describe, expect, it } from 'vitest';
import { usageRoutes } from '../../../src/modules/masters/projectActivities.js';

/**
 * @returns {{ handlers: Map<string, Function>, get: Function }}
 */
function createFakeApp() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  return {
    handlers,
    get(path, _opts, handler) {
      handlers.set(path, handler);
    },
  };
}

describe('projectActivities.routes unit edges', () => {
  it('rejects invalid from/to and missing projectId', async () => {
    const app = createFakeApp();
    await usageRoutes(/** @type {any} */ (app));
    const principal = { orgId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439012' };
    await expect(
      app.handlers.get('/usage/organization')({
        query: { from: 'not-a-date' },
        principal,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      app.handlers.get('/usage/organization')({
        query: { to: 'also-bad' },
        principal,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      app.handlers.get('/usage/projects/:projectId')({
        params: { projectId: '' },
        principal,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
