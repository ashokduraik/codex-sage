/**
 * Membership service unit tests — last admin and audit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audit/index.js', () => ({
  recordAuditEvent: vi.fn(async () => {}),
}));

vi.mock('./lastAdminGuard.js', () => ({
  wouldRemoveLastAdmin: vi.fn(async () => false),
}));

vi.mock('./membership.repository.js', () => ({
  findMembership: vi.fn(async () => ({
    _id: 'mem1',
    roleIds: ['old-role'],
  })),
  replaceMembershipRoleIds: vi.fn(async () => ({ _id: 'mem1' })),
}));

vi.mock('./role.repository.js', () => ({
  findRolesByIds: vi.fn(async (_orgId, ids) =>
    ids.map((id) => ({ _id: id, name: 'R', isBuiltIn: false })),
  ),
}));

vi.mock('./user.repository.js', () => ({
  findUserById: vi.fn(async () => ({
    _id: 'user1',
    email: 'u@example.com',
    displayName: 'U',
    userStatus: 'active',
    createdAt: new Date(),
  })),
}));

import { recordAuditEvent } from '../audit/index.js';
import { wouldRemoveLastAdmin } from './lastAdminGuard.js';
import { replaceUserRoles } from './membership.service.js';

describe('membership.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wouldRemoveLastAdmin.mockResolvedValue(false);
  });

  it('replaceUserRoles writes one user.roles_changed audit event', async () => {
    await replaceUserRoles({
      orgId: 'org1',
      actorUserId: 'actor',
      targetUserId: 'user1',
      roleIds: ['new-role-aaaaaaaaaaaaaaaa'],
      correlationId: 'c1',
    });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.roles_changed',
        context: expect.objectContaining({
          previousRoleIds: ['old-role'],
          nextRoleIds: ['new-role-aaaaaaaaaaaaaaaa'],
        }),
      }),
      expect.anything(),
    );
  });

  it('replaceUserRoles throws LAST_ADMIN_REQUIRED when the guard fires', async () => {
    wouldRemoveLastAdmin.mockResolvedValue(true);
    await expect(
      replaceUserRoles({
        orgId: 'org1',
        actorUserId: 'actor',
        targetUserId: 'user1',
        roleIds: ['viewer'],
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN_REQUIRED' });
  });
});
