/**
 * Unit tests for project route validation edge paths.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./projects.service.js', () => ({
  createProject: vi.fn(async () => ({ id: 'p1' })),
  listProjects: vi.fn(async () => ({ items: [], pageInfo: { nextCursor: null, hasMore: false } })),
  getProject: vi.fn(async () => ({ id: 'p1' })),
  recordProjectAccess: vi.fn(async () => ({ id: 'p1', lastAccessedAt: '2026-01-01T00:00:00.000Z' })),
  updateProject: vi.fn(async () => ({ id: 'p1' })),
  getProjectSettings: vi.fn(async () => ({ settings: {} })),
  patchProjectSettings: vi.fn(async () => ({ settings: {} })),
  archiveProject: vi.fn(async () => ({ id: 'p1' })),
  restoreProject: vi.fn(async () => ({ id: 'p1' })),
  getDeletionPreview: vi.fn(async () => ({ counts: {}, consequences: [] })),
  deleteProject: vi.fn(async () => undefined),
}));

vi.mock('../audit/index.js', () => ({
  buildAuditContextFromRequest: () => ({
    correlationId: 'corr',
    ip: '127.0.0.1',
    userAgent: 'test',
  }),
}));

vi.mock('../../http/preHandlers/requireProjectPermission.js', () => ({
  requireProjectPermission: () => async () => undefined,
}));

import { projectRoutes } from './projects.routes.js';

/**
 * Captures registered handlers by method+path.
 * @returns {{
 *   handlers: Map<string, Function>,
 *   post: Function,
 *   get: Function,
 *   patch: Function,
 *   delete: Function,
 * }}
 */
function createFakeApp() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  /**
   * @param {string} method
   * @param {string} path
   * @param {object} _opts
   * @param {Function} handler
   */
  function register(method, path, _opts, handler) {
    handlers.set(`${method} ${path}`, handler);
  }
  return {
    handlers,
    post(path, opts, handler) {
      register('POST', path, opts, handler);
    },
    get(path, opts, handler) {
      register('GET', path, opts, handler);
    },
    patch(path, opts, handler) {
      register('PATCH', path, opts, handler);
    },
    delete(path, opts, handler) {
      register('DELETE', path, opts, handler);
    },
  };
}

/**
 * @returns {{
 *   principal: object,
 *   projectScope: object,
 *   log: object,
 *   body?: unknown,
 *   query?: unknown,
 *   params?: unknown,
 * }}
 */
function baseRequest() {
  return {
    principal: { orgId: 'o1', userId: 'u1' },
    projectScope: { orgId: 'o1', projectId: 'p1', userId: 'u1', permissions: [] },
    log: { error: () => {} },
    body: {},
    query: {},
    params: {},
  };
}

describe('projects.routes unit edges', () => {
  it('rejects invalid create body and empty projectId params', async () => {
    const app = createFakeApp();
    await projectRoutes(/** @type {any} */ (app));

    await expect(
      app.handlers.get('POST /projects')({
        ...baseRequest(),
        body: { name: '', sourceType: 'upload' },
      }, { code: () => ({ send: () => undefined }) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      app.handlers.get('GET /projects/:projectId')({
        ...baseRequest(),
        params: { projectId: '' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects limit=0 and empty patch body', async () => {
    const app = createFakeApp();
    await projectRoutes(/** @type {any} */ (app));

    await expect(
      app.handlers.get('GET /projects')({
        ...baseRequest(),
        query: { limit: 0 },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      app.handlers.get('PATCH /projects/:projectId')({
        ...baseRequest(),
        params: { projectId: 'p1' },
        body: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects invalid settings body and empty params on mutation routes', async () => {
    const app = createFakeApp();
    await projectRoutes(/** @type {any} */ (app));

    await expect(
      app.handlers.get('PATCH /projects/:projectId/settings')({
        ...baseRequest(),
        params: { projectId: 'p1' },
        body: { settings: 'nope' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    for (const key of [
      'GET /projects/:projectId/settings',
      'POST /projects/:projectId/access',
      'POST /projects/:projectId/archive',
      'POST /projects/:projectId/restore',
      'GET /projects/:projectId/deletion-preview',
      'DELETE /projects/:projectId',
      'PATCH /projects/:projectId',
    ]) {
      await expect(
        app.handlers.get(key)({
          ...baseRequest(),
          params: { projectId: '' },
        }, { code: () => ({ send: () => undefined }) }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('accepts includeArchived query coercion', async () => {
    const app = createFakeApp();
    await projectRoutes(/** @type {any} */ (app));
    const { listProjects, getProjectSettings, recordProjectAccess } = await import(
      './projects.service.js'
    );
    await app.handlers.get('GET /projects')({
      ...baseRequest(),
      query: { includeArchived: 'true', q: 'atlas', sort: 'lastAccessedAt' },
    });
    expect(listProjects).toHaveBeenCalledWith(
      'o1',
      'u1',
      expect.objectContaining({
        includeArchived: true,
        q: 'atlas',
        sort: 'lastAccessedAt',
      }),
    );

    await expect(
      app.handlers.get('GET /projects')({
        ...baseRequest(),
        query: { limit: 'nope' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await app.handlers.get('GET /projects/:projectId/settings')({
      ...baseRequest(),
      params: { projectId: 'p1' },
    });
    expect(getProjectSettings).toHaveBeenCalledWith('o1', 'p1');

    await app.handlers.get('POST /projects/:projectId/access')({
      ...baseRequest(),
      params: { projectId: 'p1' },
    });
    expect(recordProjectAccess).toHaveBeenCalledWith('o1', 'p1');

    await expect(
      app.handlers.get('PATCH /projects/:projectId/settings')({
        ...baseRequest(),
        params: { projectId: '' },
        body: { settings: {} },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
