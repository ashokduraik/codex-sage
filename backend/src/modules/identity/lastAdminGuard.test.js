/**
 * lastAdminGuard unit tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../authorization/permissionResolver.js', () => ({
  resolveEffectivePermissions: vi.fn(async (_orgId, roleIds) => {
    if (roleIds.includes('admin-role')) {
      return ['users.manage', 'org.view'];
    }
    return ['org.view'];
  }),
}));

vi.mock('./membership.repository.js', () => ({
  listMemberships: vi.fn(),
}));

vi.mock('./user.repository.js', () => ({
  findUserById: vi.fn(),
}));

import { listMemberships } from './membership.repository.js';
import { findUserById } from './user.repository.js';
import {
  countActiveUsersManageHolders,
  wouldRemoveLastAdmin,
} from './lastAdminGuard.js';

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
