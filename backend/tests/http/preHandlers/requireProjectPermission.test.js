/**
 * Unit tests for requireProjectPermission preHandler.
 */
import mongoose from 'mongoose';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { requireProjectPermission } from '../../../src/http/preHandlers/requireProjectPermission.js';

vi.mock('../../../src/modules/masters/index.js', () => ({
  resolveProjectPermissions: vi.fn(),
}));

import { resolveProjectPermissions } from '../../../src/modules/masters/index.js';

describe('requireProjectPermission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for non-ObjectId projectId in GET params without resolving', async () => {
    const pre = requireProjectPermission('projects.view');
    const request = {
      method: 'GET',
      principal: { orgId: 'o1', userId: 'u1' },
      params: { projectId: 'not-an-id' },
    };
    await expect(pre(request)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(resolveProjectPermissions).not.toHaveBeenCalled();
  });

  it('returns 400 for non-ObjectId projectId in POST body without resolving', async () => {
    const pre = requireProjectPermission('projects.view');
    const request = {
      method: 'POST',
      principal: { orgId: 'o1', userId: 'u1' },
      body: { projectId: 'not-an-id' },
      params: {},
    };
    await expect(pre(request)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(resolveProjectPermissions).not.toHaveBeenCalled();
  });

  it('returns 404 on NO_ACCESS and 403 when permission missing for POST body', async () => {
    const projectId = new mongoose.Types.ObjectId().toHexString();
    resolveProjectPermissions.mockResolvedValueOnce({ kind: 'NO_ACCESS' });
    const viewPre = requireProjectPermission('projects.view');
    await expect(
      viewPre({
        method: 'POST',
        principal: { orgId: 'o1', userId: 'u1' },
        body: { projectId },
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
        method: 'PATCH',
        principal: { orgId: 'o1', userId: 'u1' },
        body: { projectId },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reads projectId from GET params and decorates projectScope for any mode', async () => {
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
      method: 'GET',
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

  it('reads projectId from DELETE body and ignores params', async () => {
    const bodyProjectId = new mongoose.Types.ObjectId().toHexString();
    const paramsProjectId = new mongoose.Types.ObjectId().toHexString();
    resolveProjectPermissions.mockResolvedValue({
      kind: 'OK',
      visible: true,
      permissions: ['projects.delete'],
    });
    const pre = requireProjectPermission('projects.delete');
    const request = {
      method: 'DELETE',
      principal: { orgId: 'o1', userId: 'u1' },
      body: { projectId: bodyProjectId },
      params: { projectId: paramsProjectId },
    };
    await pre(request);
    expect(resolveProjectPermissions).toHaveBeenCalledWith('o1', 'u1', bodyProjectId, expect.any(Object));
    expect(request.projectScope.projectId).toBe(bodyProjectId);
  });
});
