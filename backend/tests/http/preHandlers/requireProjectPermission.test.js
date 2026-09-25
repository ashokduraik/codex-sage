/**
 * Unit tests for requireProjectPermission preHandler.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { requireProjectPermission } from '../../../src/http/preHandlers/requireProjectPermission.js';

vi.mock('../../../src/modules/masters/index.js', () => ({
  resolveProjectPermissions: vi.fn(),
}));

import { resolveProjectPermissions } from '../../../src/modules/masters/index.js';

describe('requireProjectPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for non-ObjectId projectId without resolving', async () => {
    const pre = requireProjectPermission('projects.view');
    const request = {
      principal: { orgId: 'o1', userId: 'u1' },
      params: { projectId: 'not-an-id' },
    };
    await expect(pre(request)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(resolveProjectPermissions).not.toHaveBeenCalled();
  });

  it('returns 404 on NO_ACCESS and 403 when permission missing', async () => {
    const projectId = new mongoose.Types.ObjectId().toHexString();
    resolveProjectPermissions.mockResolvedValueOnce({ kind: 'NO_ACCESS' });
    const viewPre = requireProjectPermission('projects.view');
    await expect(
      viewPre({
        principal: { orgId: 'o1', userId: 'u1' },
        params: { projectId },
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    resolveProjectPermissions.mockResolvedValueOnce({
      kind: 'OK',
      visible: true,
      permissions: ['projects.view'],
    });
    const updatePre = requireProjectPermission('projects.update');
    await expect(
      updatePre({
        principal: { orgId: 'o1', userId: 'u1' },
        params: { projectId },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('decorates projectScope when effective permissions match any mode', async () => {
    const projectId = new mongoose.Types.ObjectId().toHexString();
    resolveProjectPermissions.mockResolvedValue({
      kind: 'OK',
      visible: true,
      permissions: ['users.manage', 'projects.view'],
    });
    const pre = requireProjectPermission(['projects.update', 'users.manage'], {
      mode: 'any',
    });
    const request = {
      principal: { orgId: 'o1', userId: 'u1' },
      params: { projectId },
    };
    await pre(request);
    expect(request.projectScope).toEqual({
      orgId: 'o1',
      projectId,
      userId: 'u1',
      permissions: ['users.manage', 'projects.view'],
    });
  });
});
