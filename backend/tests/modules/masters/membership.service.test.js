/**
 * Membership service unit tests — last admin and audit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Membership } from '../../../src/models/membership.model.js';
import { User } from '../../../src/models/user.model.js';

vi.mock('../../../src/modules/access/index.js', () => ({
  recordAuditEvent: vi.fn(async () => {}),
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

vi.mock('../../../src/modules/masters/roles.js', () => ({
  findRolesByIds: vi.fn(async (_orgId, ids) =>
    ids.map((id) => ({ _id: id, name: 'R', isBuiltIn: false })),
  ),
}));

vi.mock('../../../src/modules/masters/users.js', () => ({
  findUserById: vi.fn(async () => ({
    _id: 'user1',
    email: 'u@example.com',
    displayName: 'U',
    userStatus: 'active',
    createdAt: new Date(),
  })),
  mapUserToDto: vi.fn((user) => user),
}));

vi.mock('../../../src/modules/masters/projectMembers.js', () => ({
  bumpProjectAclVersion: vi.fn(async () => {}),
}));

import { recordAuditEvent } from '../../../src/modules/access/index.js';
import { findUserById } from '../../../src/modules/masters/users.js';
import {
  countActiveUsersManageHolders,
  replaceUserRoles,
  wouldRemoveLastAdmin,
} from '../../../src/modules/masters/memberships.js';

const ORG_ID = '665f1c9d4b2a8e0012a4f010';

/**
 * @param {object | object[] | null} value Find result.
 * @returns {void}
 */
function mockMembershipFind(value) {
  vi.spyOn(Membership, 'find').mockReturnValue({
    sort() {
      return this;
    },
    session() {
      return this;
    },
    exec: vi.fn().mockResolvedValue(value),
  });
}

/**
 * @param {object | null} value FindOne result.
 * @returns {void}
 */
function mockMembershipFindOne(value) {
  vi.spyOn(Membership, 'findOne').mockReturnValue({
    session() {
      return this;
    },
    exec: vi.fn().mockResolvedValue(value),
  });
}

describe('membership.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    findUserById.mockResolvedValue({
      _id: 'user1',
      email: 'u@example.com',
      displayName: 'U',
      userStatus: 'active',
      createdAt: new Date(),
    });
    vi.spyOn(User, 'findOne').mockReturnValue({
      session() {
        return this;
      },
      exec: vi.fn().mockResolvedValue({
        _id: 'user1',
        email: 'u@example.com',
        displayName: 'U',
        userStatus: 'active',
        createdAt: new Date(),
      }),
    });
    mockMembershipFind([{ userId: 'user1', roleIds: ['old-role'] }]);
    mockMembershipFindOne({
      _id: 'mem1',
      roleIds: ['old-role'],
    });
    vi.spyOn(Membership, 'findOneAndUpdate').mockReturnValue({
      session() {
        return this;
      },
      exec: vi.fn().mockResolvedValue({ _id: 'mem1' }),
    });
  });

  it('replaceUserRoles writes one user.roles_changed audit event', async () => {
    await replaceUserRoles({
      orgId: ORG_ID,
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
    mockMembershipFind([{ userId: 'user1', roleIds: ['admin-role'] }]);
    await expect(
      replaceUserRoles({
        orgId: ORG_ID,
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
    vi.restoreAllMocks();
  });

  it('counts only active users.manage holders', async () => {
    mockMembershipFind([
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
    expect(await countActiveUsersManageHolders(ORG_ID)).toBe(1);
  });

  it('wouldRemoveLastAdmin is true when disabling the only admin', async () => {
    findUserById.mockResolvedValue({ userStatus: 'active' });
    mockMembershipFind([{ userId: 'u1', roleIds: ['admin-role'] }]);
    expect(
      await wouldRemoveLastAdmin(ORG_ID, {
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
    mockMembershipFind([
      { userId: 'u1', roleIds: ['admin-role'] },
      { userId: 'u2', roleIds: ['admin-role'] },
    ]);
    expect(
      await wouldRemoveLastAdmin(ORG_ID, {
        targetUserId: 'u1',
        removingOrDisabling: true,
      }),
    ).toBe(false);
  });
});
