/**
 * Unit tests for audit route validation edge paths.
 */
import { describe, expect, it } from 'vitest';

import { assertAuditListDateRange, auditRoutes } from '../../../src/modules/access/audit.js';

/**
 * Captures registered GET handlers by path.
 * @returns {{ get: Function, handlers: Map<string, Function> }}
 */
function createFakeApp() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  return {
    handlers,
    /**
     * @param {string} path
     * @param {object} _opts
     * @param {Function} handler
     */
    get(path, _opts, handler) {
      handlers.set(path, handler);
    },
  };
}

describe('audit.routes unit edges', () => {
  it('rejects empty detail params via VALIDATION_ERROR', async () => {
    const app = createFakeApp();
    await auditRoutes(/** @type {any} */ (app));
    const handler = app.handlers.get('/audit-events/:auditEventId');
    await expect(
      handler({
        params: { auditEventId: '' },
        principal: { orgId: 'o1', userId: 'u1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a from/to span longer than 31 days via VALIDATION_ERROR', async () => {
    const app = createFakeApp();
    await auditRoutes(/** @type {any} */ (app));
    const handler = app.handlers.get('/audit-events');
    await expect(
      handler({
        query: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z' },
        principal: { orgId: 'o1', userId: 'u1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects to before from via VALIDATION_ERROR', async () => {
    expect(() => assertAuditListDateRange(new Date('2026-09-12T00:00:00.000Z'), new Date('2026-09-01T00:00:00.000Z'))).toThrow();
    expect(() => assertAuditListDateRange(new Date('2026-09-01T00:00:00.000Z'), new Date('2026-10-02T00:00:00.000Z'))).not.toThrow();
    expect(() => assertAuditListDateRange(undefined, new Date('2026-09-01T00:00:00.000Z'))).not.toThrow();
  });

  it('rejects invalid to query via VALIDATION_ERROR', async () => {
    const app = createFakeApp();
    await auditRoutes(/** @type {any} */ (app));
    const handler = app.handlers.get('/audit-events');
    await expect(
      handler({
        query: { to: 'definitely-not-a-date' },
        principal: { orgId: 'o1', userId: 'u1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
