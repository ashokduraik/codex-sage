/**
 * Unit tests for project route validation edge paths.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/modules/access/index.js', () => ({
  buildAuditContextFromRequest: () => ({
    correlationId: 'corr',
    ip: '127.0.0.1',
    userAgent: 'test',
  }),
}));

import {
  getProjectHttp,
  listProjectsHttp,
  createProjectHttp,
  deleteProjectHttp,
  updateProjectHttp,
  archiveProjectHttp,
  restoreProjectHttp,
  getProjectSettingsHttp,
  recordProjectAccessHttp,
  updateProjectSettingsHttp,
  getProjectDeletionPreviewHttp,
  fillProjectDescriptionFromReadmeHttp,
} from '../../../src/modules/masters/projects.js';

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
    await expect(
      createProjectHttp(
        {
          ...baseRequest(),
          body: { name: '', sourceType: 'upload' },
        },
        { code: () => ({ send: () => undefined }) },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      getProjectHttp({
        ...baseRequest(),
        params: { projectId: '' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects limit=0 and empty patch body', async () => {
    await expect(
      listProjectsHttp({
        ...baseRequest(),
        query: { limit: 0 },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      updateProjectHttp({
        ...baseRequest(),
        params: { projectId: 'p1' },
        body: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects invalid settings body and empty params on mutation routes', async () => {
    await expect(
      updateProjectSettingsHttp({
        ...baseRequest(),
        params: { projectId: 'p1' },
        body: { settings: 'nope' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    for (const handler of [
      getProjectSettingsHttp,
      recordProjectAccessHttp,
      archiveProjectHttp,
      restoreProjectHttp,
      getProjectDeletionPreviewHttp,
      deleteProjectHttp,
      updateProjectHttp,
      fillProjectDescriptionFromReadmeHttp,
    ]) {
      await expect(
        handler(
          {
            ...baseRequest(),
            params: { projectId: '' },
          },
          { code: () => ({ send: () => undefined }) },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('rejects invalid list limit and empty settings projectId', async () => {
    await expect(
      listProjectsHttp({
        ...baseRequest(),
        query: { limit: 'nope' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      updateProjectSettingsHttp({
        ...baseRequest(),
        params: { projectId: '' },
        body: { settings: {} },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
