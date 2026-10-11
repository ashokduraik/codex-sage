/**
 * projectsApi request builders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getProject,
  listProjects,
  patchProject,
  createProject,
  deleteProject,
  archiveProject,
  restoreProject,
  recordProjectAccess,
  getProjectDeletionPreview,
} from '@/features/projects/api/projectsApi.js';

const apiRequest = vi.fn();

vi.mock('@/shared/api/index', () => ({
  apiRequest: (...args) => apiRequest(...args),
}));

describe('projectsApi', () => {
  afterEach(() => {
    apiRequest.mockReset();
  });

  it('lists with query params and default limit', async () => {
    apiRequest.mockResolvedValue({ items: [], pageInfo: { nextCursor: null, hasMore: false } });
    await listProjects({
      q: 'atlas',
      includeArchived: true,
      sort: 'lastAccessedAt',
      cursor: 'c1',
    });
    expect(apiRequest).toHaveBeenCalledWith(expect.stringMatching(/^\/projects\?/), expect.objectContaining({ signal: undefined }));
    const path = apiRequest.mock.calls[0][0];
    expect(path).toContain('q=atlas');
    expect(path).toContain('includeArchived=true');
    expect(path).toContain('sort=lastAccessedAt');
    expect(path).toContain('cursor=c1');
    expect(path).toContain('limit=20');
  });

  it('creates with Idempotency-Key and maps remaining verbs', async () => {
    apiRequest.mockResolvedValue({ id: 'p1' });
    await createProject({
      name: 'A',
      description: 'B',
      sourceType: 'upload',
      idempotencyKey: 'idem-1',
    });
    expect(apiRequest).toHaveBeenCalledWith('/projects', {
      method: 'POST',
      body: { name: 'A', description: 'B', sourceType: 'upload' },
      idempotencyKey: 'idem-1',
    });

    await getProject('p1', { signal: undefined });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1', { signal: undefined });

    await patchProject('p1', { name: 'N' });
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1', {
      method: 'PATCH',
      body: { name: 'N' },
    });

    await archiveProject('p1');
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/archive', { method: 'POST' });

    await restoreProject('p1');
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/restore', { method: 'POST' });

    await deleteProject('p1');
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1', { method: 'DELETE' });

    await getProjectDeletionPreview('p1');
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/deletion-preview', {
      signal: undefined,
    });

    await recordProjectAccess('p1');
    expect(apiRequest).toHaveBeenCalledWith('/projects/p1/access', { method: 'POST' });
  });
});
