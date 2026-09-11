/**
 * User service unit tests — guards and conflict mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../audit/index.js', () => ({
  recordAuditEvent: vi.fn(async () => {}),
}));

vi.mock('../auth/session.repository.js', () => ({
  revokeAllSessionsForUser: vi.fn(async () => ({})),
}));

vi.mock('./lastAdminGuard.js', () => ({
  wouldRemoveLastAdmin: vi.fn(async () => false),
}));

vi.mock('./membership.service.js', () => ({
  assertRolesExistInOrg: vi.fn(async (_orgId, roleIds) =>
    roleIds.map((id) => ({ _id: id, name: 'Role', isBuiltIn: false })),
  ),
}));

vi.mock('./membership.repository.js', () => ({
  createMembership: vi.fn(async () => ({})),
  findMembership: vi.fn(async () => ({
    roleIds: ['role-admin'],
  })),
  replaceMembershipRoleIds: vi.fn(async () => ({})),
  softDeleteMembership: vi.fn(async () => ({ modifiedCount: 1 })),
}));

vi.mock('./role.repository.js', () => ({
  findRolesByIds: vi.fn(async (_orgId, ids) =>
    ids.map((id) => ({ _id: id, name: 'Role', isBuiltIn: false })),
  ),
  isDuplicateKeyError: vi.fn(
    (err) => typeof err === 'object' && err !== null && err.code === 11000,
  ),
}));

vi.mock('./user.repository.js', () => ({
  createUser: vi.fn(),
  findUserById: vi.fn(),
  listUsers: vi.fn(),
  softDeleteUser: vi.fn(async () => ({ modifiedCount: 1 })),
  updateUser: vi.fn(),
}));

vi.mock('mongoose', () => ({
  default: {
    startSession: vi.fn(async () => ({
      withTransaction: async (fn) => fn(),
      endSession: async () => {},
    })),
  },
}));

import { recordAuditEvent } from '../audit/index.js';
import { revokeAllSessionsForUser } from '../auth/session.repository.js';
import { wouldRemoveLastAdmin } from './lastAdminGuard.js';
import { createUser as createUserInRepo, findUserById, updateUser } from './user.repository.js';
import {
  createUser,
  deactivateUser,
  removeUser,
  updateUserDetails,
} from './user.service.js';

describe('user.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wouldRemoveLastAdmin.mockResolvedValue(false);
  });

  it('createUser maps a duplicate-key error to IDENTITY_DUPLICATE_EMAIL', async () => {
    createUserInRepo.mockRejectedValue({ code: 11000 });
    await expect(
      createUser({
        orgId: 'org1',
        actorUserId: 'actor',
        email: 'a@example.com',
        displayName: 'A',
        roleIds: ['bbbbbbbbbbbbbbbbbbbbbbbb'],
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_DUPLICATE_EMAIL' });
  });

  it('deactivateUser throws CANNOT_MODIFY_SELF for the acting user', async () => {
    await expect(
      deactivateUser({
        orgId: 'org1',
        actorUserId: 'same',
        targetUserId: 'same',
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
  });

  it('deactivateUser throws LAST_ADMIN_REQUIRED when the guard fires', async () => {
    findUserById.mockResolvedValue({
      _id: 'target',
      email: 't@example.com',
      displayName: 'T',
      userStatus: 'active',
      createdAt: new Date(),
    });
    wouldRemoveLastAdmin.mockResolvedValue(true);
    await expect(
      deactivateUser({
        orgId: 'org1',
        actorUserId: 'actor',
        targetUserId: 'target',
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN_REQUIRED' });
  });

  it('removeUser throws CANNOT_MODIFY_SELF for the acting user', async () => {
    await expect(
      removeUser({
        orgId: 'org1',
        actorUserId: 'same',
        targetUserId: 'same',
        correlationId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF' });
  });

  it('updateUserDetails revokes sessions and audits email changes', async () => {
    findUserById.mockResolvedValue({
      _id: 'target',
      email: 'old@example.com',
      displayName: 'T',
      userStatus: 'active',
      createdAt: new Date(),
    });
    updateUser.mockResolvedValue({
      _id: 'target',
      email: 'new@example.com',
      displayName: 'T',
      userStatus: 'active',
      createdAt: new Date(),
    });

    const dto = await updateUserDetails({
      orgId: 'org1',
      actorUserId: 'actor',
      targetUserId: 'target',
      email: 'new@example.com',
      correlationId: 'c1',
    });

    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(
      'org1',
      'target',
      'email_changed',
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.email_changed' }),
      expect.anything(),
    );
    expect(dto.email).toBe('new@example.com');
  });
});
