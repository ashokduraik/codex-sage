/**
 * User role service unit tests — last admin and audit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  revokeAllLoginSessionsForUser: vi.fn(async () => ({})),
  adminSetPassword: vi.fn(),
  buildAuditContextFromRequest: vi.fn(() => ({})),
  getPasswordResetStatus: () => ({ state: 'none', completedAt: null }),
  PASSWORD_MIN_LENGTH: 6,
}));

vi.mock('../../../src/modules/masters/roles.js', () => ({
  findRolesByIds: vi.fn(async (_orgId, ids) =>
    ids.map((id) => ({ _id: id, name: 'R', isBuiltIn: false })),
  ),
  isDuplicateKeyError: vi.fn(() => false),
}));

vi.mock('../../../src/modules/masters/projectMembers.js', () => ({
  bumpProjectAclVersion: vi.fn(async () => {}),
}));

import { recordAuditEvent } from '../../../src/modules/access/index.js';
import { findRolesByIds } from '../../../src/modules/masters/roles.js';
import {
  assertRolesExistInOrg,
  countActiveUsersManageHolders,
  isRoleReferencedByActiveUser,
  replaceUserRoles,
  wouldRemoveLastAdmin,
} from '../../../src/modules/masters/users.js';

const ORG_ID = '665f1c9d4b2a8e0012a4f010';

/**
 * @param {object | object[] | null} value Find result.
 * @returns {void}
 */
function mockUserFind(value) {
  vi.spyOn(User, 'find').mockReturnValue({
    exec: vi.fn().mockResolvedValue(value),
  });
}

/**
 * @param {object | null} value FindOne result.
 * @returns {void}
 */
function mockUserFindOne(value) {
  vi.spyOn(User, 'findOne').mockReturnValue({
    session() {
      return this;
    },
    select() {
      return this;
    },
    exec: vi.fn().mockResolvedValue(value),
  });
}

describe('user role replace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mockUserFindOne({
      _id: 'user1',
      email: 'u@example.com',
      displayName: 'U',
      userStatus: 'active',
      roleIds: ['old-role'],
      createdAt: new Date(),
    });
    mockUserFind([{ _id: 'user1', userStatus: 'active', roleIds: ['old-role'] }]);
    vi.spyOn(User, 'findOneAndUpdate').mockReturnValue({
      session() {
        return this;
      },
      exec: vi.fn().mockResolvedValue({
        _id: 'user1',
        email: 'u@example.com',
        displayName: 'U',
        userStatus: 'active',
        roleIds: ['new-role-aaaaaaaaaaaaaaaa'],
        createdAt: new Date(),
      }),
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
    mockUserFindOne({
      _id: 'user1',
      userStatus: 'active',
      roleIds: ['admin-role'],
    });
    mockUserFind([{ _id: 'user1', userStatus: 'active', roleIds: ['admin-role'] }]);
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
    mockUserFind([
      { _id: 'u1', userStatus: 'active', roleIds: ['admin-role'] },
      { _id: 'u2', userStatus: 'active', roleIds: ['member-role'] },
      { _id: 'u3', userStatus: 'disabled', roleIds: ['admin-role'] },
    ]);
    expect(await countActiveUsersManageHolders(ORG_ID)).toBe(1);
  });

  it('wouldRemoveLastAdmin is true when disabling the only admin', async () => {
    mockUserFindOne({
      _id: 'u1',
      userStatus: 'active',
      roleIds: ['admin-role'],
    });
    mockUserFind([{ _id: 'u1', userStatus: 'active', roleIds: ['admin-role'] }]);
    expect(
      await wouldRemoveLastAdmin(ORG_ID, {
        targetUserId: 'u1',
        removingOrDisabling: true,
      }),
    ).toBe(true);
  });

  it('wouldRemoveLastAdmin is false when another admin remains', async () => {
    mockUserFindOne({
      _id: 'u1',
      userStatus: 'active',
      roleIds: ['admin-role'],
    });
    mockUserFind([
      { _id: 'u1', userStatus: 'active', roleIds: ['admin-role'] },
      { _id: 'u2', userStatus: 'active', roleIds: ['admin-role'] },
    ]);
    expect(
      await wouldRemoveLastAdmin(ORG_ID, {
        targetUserId: 'u1',
        removingOrDisabling: true,
      }),
    ).toBe(false);
  });

  it('wouldRemoveLastAdmin is false when next roles still include users.manage', async () => {
    mockUserFindOne({
      _id: 'u1',
      userStatus: 'active',
      roleIds: ['admin-role'],
    });
    expect(
      await wouldRemoveLastAdmin(ORG_ID, {
        targetUserId: 'u1',
        nextRoleIds: ['admin-role'],
      }),
    ).toBe(false);
  });

  it('isRoleReferencedByActiveUser is false for an invalid id', async () => {
    expect(await isRoleReferencedByActiveUser(ORG_ID, 'not-an-id')).toBe(false);
  });

  it('isRoleReferencedByActiveUser is true when a user holds the role', async () => {
    mockUserFindOne({ _id: 'u1' });
    expect(
      await isRoleReferencedByActiveUser(ORG_ID, '665f1c9d4b2a8e0012a4f011', {
        session: {},
      }),
    ).toBe(true);
  });

  it('wouldRemoveLastAdmin is false when the target user is missing', async () => {
    mockUserFindOne(null);
    expect(
      await wouldRemoveLastAdmin(ORG_ID, {
        targetUserId: 'missing',
        removingOrDisabling: true,
      }),
    ).toBe(false);
  });

  it('wouldRemoveLastAdmin is false when the target is not an admin', async () => {
    mockUserFindOne({
      _id: 'u1',
      userStatus: 'active',
      roleIds: ['member-role'],
    });
    expect(
      await wouldRemoveLastAdmin(ORG_ID, {
        targetUserId: 'u1',
        removingOrDisabling: true,
      }),
    ).toBe(false);
  });

  it('wouldRemoveLastAdmin is false when neither disable nor next roles are set', async () => {
    mockUserFindOne({
      _id: 'u1',
      userStatus: 'active',
      roleIds: ['admin-role'],
    });
    expect(await wouldRemoveLastAdmin(ORG_ID, { targetUserId: 'u1' })).toBe(false);
  });

  it('assertRolesExistInOrg throws when a role is missing', async () => {
    findRolesByIds.mockResolvedValueOnce([]);
    await expect(assertRolesExistInOrg(ORG_ID, ['missing-role'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
