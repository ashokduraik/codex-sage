/**
 * Service race / defensive branches via repository mocks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/modules/masters/projects.helper.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createProject: vi.fn(),
    findProjectById: vi.fn(),
    listProjects: vi.fn(),
    updateProjectMetadata: vi.fn(),
    updateProjectSettings: vi.fn(),
    conditionalLifecycleUpdate: vi.fn(),
    softDeleteProject: vi.fn(),
  };
});

vi.mock('../../../src/modules/access/index.js', () => ({
  recordAuditEvent: vi.fn(async () => undefined),
}));

import {
  archiveProject,
  deleteProject,
  patchProjectSettings,
  restoreProject,
  transitionLifecycle,
  updateProject,
} from '../../../src/modules/masters/projects.js';
import * as repo from '../../../src/modules/masters/projects.helper.js';

describe('projects.service race branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws NOT_FOUND when metadata update loses a race', async () => {
    repo.findProjectById.mockResolvedValueOnce({ _id: 'p1', name: 'A' });
    repo.updateProjectMetadata.mockResolvedValueOnce(null);
    await expect(
      updateProject({
        orgId: 'o1',
        actorUserId: 'u1',
        projectId: 'p1',
        name: 'B',
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND when settings update loses a race', async () => {
    repo.findProjectById.mockResolvedValueOnce({ _id: 'p1', settings: {} });
    repo.updateProjectSettings.mockResolvedValueOnce(null);
    await expect(
      patchProjectSettings({
        orgId: 'o1',
        actorUserId: 'u1',
        projectId: 'p1',
        settings: {},
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND when soft-delete matches zero rows', async () => {
    repo.findProjectById.mockResolvedValueOnce({
      _id: 'p1',
      name: 'A',
      lifecycleStatus: 'awaiting_source',
    });
    repo.softDeleteProject.mockResolvedValueOnce({ matchedCount: 0 });
    await expect(
      deleteProject({
        orgId: 'o1',
        actorUserId: 'u1',
        projectId: 'p1',
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws when restore conditional update loses a race', async () => {
    repo.findProjectById.mockResolvedValueOnce({
      _id: 'p1',
      lifecycleStatus: 'archived',
      preArchiveLifecycleStatus: 'failed',
    });
    repo.conditionalLifecycleUpdate.mockResolvedValueOnce(null);
    await expect(
      restoreProject({
        orgId: 'o1',
        actorUserId: 'u1',
        projectId: 'p1',
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('retries a successful transition after a lost first update', async () => {
    repo.conditionalLifecycleUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: 'p1',
        name: 'A',
        lifecycleStatus: 'failed',
        knowledgeHealth: 'none',
        sourceConfig: { sourceType: 'upload' },
        counts: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    repo.findProjectById.mockResolvedValueOnce({
      _id: 'p1',
      lifecycleStatus: 'awaiting_source',
    });

    const result = await transitionLifecycle({
      orgId: 'o1',
      projectId: 'p1',
      from: 'processing',
      to: 'failed',
      source: 'api',
      actorUserId: 'u1',
    });
    expect(result.lifecycleStatus).toBe('failed');
    expect(repo.conditionalLifecycleUpdate).toHaveBeenCalledTimes(2);
  });

  it('archives via transition when find succeeds', async () => {
    repo.findProjectById.mockResolvedValue({
      _id: 'p1',
      lifecycleStatus: 'awaiting_source',
      name: 'A',
      knowledgeHealth: 'none',
      sourceConfig: { sourceType: 'upload' },
      counts: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    repo.conditionalLifecycleUpdate.mockResolvedValue({
      _id: 'p1',
      lifecycleStatus: 'archived',
      name: 'A',
      knowledgeHealth: 'none',
      sourceConfig: { sourceType: 'upload' },
      counts: {},
      archivedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const archived = await archiveProject({
      orgId: 'o1',
      actorUserId: 'u1',
      projectId: 'p1',
      correlationId: 'c',
    });
    expect(archived.lifecycleStatus).toBe('archived');
  });
});
