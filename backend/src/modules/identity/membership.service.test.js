/**
 * Membership service unit tests — last admin and audit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audit/index.js', () => ({
  recordAuditEvent: vi.fn(async () => {}),
}));

vi.mock('../authorization/permissionResolver.js', () => ({
  resolveEffectivePermissions: vi.fn(async (_orgId, roleIds) => {
    if (roleIds.includes('admin-role')) {
      return ['users.manage', 'org.view'];
    }
    if (roleIds.includes('viewer') || roleIds.includes('member-role')) {
      return ['org.view'];
    }
    return ['users.manage', 'org.view'];
  }),
}));

vi.mock('./membership.repository.js', () => ({
  findMembership: vi.fn(async () => ({
    _id: 'mem1',
    roleIds: ['old-role'],
  })),
  listMemberships: vi.fn(async () => [{ userId: 'user1', roleIds: ['old-role'] }]),
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

vi.mock('../projectMembers/projectAclCache.js', () => ({
  bumpProjectAclVersion: vi.fn(async () => {}),
}));

vi.mock('./user.service.js', () => ({
  mapUserToDto: vi.fn((user, roles = []) => ({
    id: String(user._id ?? user.id),
    email: user.email,
    displayName: user.displayName,
    userStatus: user.userStatus,
    roles: roles.map((role) => ({
      id: String(role._id ?? role.id),
      name: role.name,
      isBuiltIn: Boolean(role.isBuiltIn),
    })),
    lastLoginAt: null,
    passwordResetStatus: 'none',
    passwordResetCompletedAt: null,
    createdAt:
      user.createdAt instanceof Date
        ? user.createdAt.toISOString()
        : String(user.createdAt ?? ''),
  })),
}));

import { recordAuditEvent } from '../audit/index.js';
import { listMemberships } from './membership.repository.js';
import { findUserById } from './user.repository.js';
import {
  countActiveUsersManageHolders,
  replaceUserRoles,
  wouldRemoveLastAdmin,
} from './membership.service.js';

describe('membership.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUserById.mockResolvedValue({
      _id: 'user1',
      email: 'u@example.com',
      displayName: 'U',
      userStatus: 'active',
      createdAt: new Date(),
    });
    listMemberships.mockResolvedValue([{ userId: 'user1', roleIds: ['old-role'] }]);
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

describe('lastAdminGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('counts only active users.manage holders', async () => {
    listMemberships.mockResolvedValue([
      { userId: 'u1', roleIds: ['admin-role'] },
      { userId: 'u2', roleIds: ['member-role'] },
      { userId: 'u3', roleIds: ['admin-role'] },
    ]);
    findUserById.mockImplementation(async (_org, userId) => {
      if (userId === 'u3') {
        return { userStatus: 'disabled' };
      }
      return { userStatus: 'active' };
    });
    expect(await countActiveUsersManageHolders('org1')).toBe(1);
  });

  it('wouldRemoveLastAdmin is true when disabling the only admin', async () => {
    findUserById.mockResolvedValue({ userStatus: 'active' });
    listMemberships.mockResolvedValue([
      { userId: 'u1', roleIds: ['admin-role'] },
    ]);
    expect(
      await wouldRemoveLastAdmin('org1', {
        targetUserId: 'u1',
        removingOrDisabling: true,
      }),
    ).toBe(true);
  });

  it('wouldRemoveLastAdmin is false when another admin remains', async () => {
    findUserById.mockImplementation(async (_org, userId) => ({
      userStatus: 'active',
      _id: userId,
    }));
    listMemberships.mockResolvedValue([
      { userId: 'u1', roleIds: ['admin-role'] },
      { userId: 'u2', roleIds: ['admin-role'] },
    ]);
    expect(
      await wouldRemoveLastAdmin('org1', {
        targetUserId: 'u1',
        removingOrDisabling: true,
      }),
    ).toBe(false);
  });
});
