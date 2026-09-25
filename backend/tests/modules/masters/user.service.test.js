/**
 * User service unit tests — guards and conflict mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { User } from '../../../src/models/user.model.js';

vi.mock('../../../src/modules/access/index.js', () => ({
  recordAuditEvent: vi.fn(async () => {}),
  revokeAllSessionsForUser: vi.fn(async () => ({})),
  adminSetPassword: vi.fn(),
  buildAuditContextFromRequest: vi.fn(() => ({})),
  getPasswordResetStatus: (user) => {
    if (user?.passwordUpdatedAt instanceof Date) {
      return {
        state: 'completed',
        completedAt: user.passwordUpdatedAt.toISOString(),
      };
    }
    return { state: 'none', completedAt: null };
  },
  PASSWORD_MIN_LENGTH: 6,
}));

vi.mock('../../../src/modules/masters/users.helper.js', () => ({
  assertRolesExistInOrg: vi.fn(async (_orgId, roleIds) =>
    roleIds.map((id) => ({ _id: id, name: 'Role', isBuiltIn: false })),
  ),
  wouldRemoveLastAdmin: vi.fn(async () => false),
  isRoleReferencedByActiveUser: vi.fn(async () => false),
  countActiveUsersManageHolders: vi.fn(async () => 0),
  holdsUsersManage: vi.fn(() => false),
}));

vi.mock('../../../src/modules/masters/roles.js', () => ({
  findRolesByIds: vi.fn(async (_orgId, ids) =>
    ids.map((id) => ({ _id: id, name: 'Role', isBuiltIn: false })),
  ),
  isDuplicateKeyError: vi.fn(
    (err) => typeof err === 'object' && err !== null && err.code === 11000,
  ),
}));

vi.mock('../../../src/modules/masters/projectMembers.js', () => ({
  bumpProjectAclVersion: vi.fn(async () => {}),
}));

vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      startSession: vi.fn(async () => ({
        withTransaction: async (fn) => fn(),
        endSession: async () => {},
      })),
    },
  };
});

import { recordAuditEvent, revokeAllSessionsForUser } from '../../../src/modules/access/index.js';
import { wouldRemoveLastAdmin } from '../../../src/modules/masters/users.helper.js';
import {
  containsForbiddenSecretKey,
  createUser,
  deactivateUser,
  mapUserToDto,
  removeUser,
  updateUserDetails,
} from '../../../src/modules/masters/users.js';

/**
 * @param {object | null} doc User document.
 * @returns {void}
 */
function mockFindUser(doc) {
  vi.spyOn(User, 'findOne').mockReturnValue({
    session() {
      return this;
    },
    exec: vi.fn().mockResolvedValue(doc),
  });
}

describe('user.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    wouldRemoveLastAdmin.mockResolvedValue(false);
  });

  it('createUser maps a duplicate-key error to IDENTITY_DUPLICATE_EMAIL', async () => {
    vi.spyOn(User, 'create').mockRejectedValue({ code: 11000 });
    await expect(
      createUser({
        orgId: '665f1c9d4b2a8e0012a4f010',
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
    mockFindUser({
      _id: 'target',
      email: 't@example.com',
      displayName: 'T',
      userStatus: 'active',
      createdAt: new Date(),
    });
    wouldRemoveLastAdmin.mockResolvedValue(true);
    await expect(
      deactivateUser({
        orgId: '665f1c9d4b2a8e0012a4f010',
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
    mockFindUser({
      _id: 'target',
      email: 'old@example.com',
      displayName: 'T',
      userStatus: 'active',
      createdAt: new Date(),
    });
    vi.spyOn(User, 'findOneAndUpdate').mockReturnValue({
      session() {
        return this;
      },
      exec: vi.fn().mockResolvedValue({
        _id: 'target',
        email: 'new@example.com',
        displayName: 'T',
        userStatus: 'active',
        createdAt: new Date(),
      }),
    });

    const dto = await updateUserDetails({
      orgId: '665f1c9d4b2a8e0012a4f010',
      actorUserId: 'actor',
      targetUserId: 'target',
      email: 'new@example.com',
      correlationId: 'c1',
    });

    expect(revokeAllSessionsForUser).toHaveBeenCalledWith(
      '665f1c9d4b2a8e0012a4f010',
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

describe('mapUserToDto', () => {
  it('maps a user without passwordHash or token-shaped keys', () => {
    const dto = mapUserToDto(
      {
        _id: '6712f0b1c9a41d2f8e4b3a04',
        email: 'ada@acme.example',
        displayName: 'Ada',
        userStatus: 'invited',
        lastLoginAt: null,
        createdAt: new Date('2026-09-11T09:14:22.481Z'),
        passwordHash: 'should-not-leak',
      },
      [{ _id: '6712f0b1c9a41d2f8e4b3a03', name: 'Member', isBuiltIn: true }],
    );
    expect(dto.passwordResetStatus).toBe('none');
    expect(containsForbiddenSecretKey(dto)).toBe(false);
    expect(dto).not.toHaveProperty('passwordHash');
  });

  it('maps passwordResetStatus completed when passwordUpdatedAt is set', () => {
    const completedAt = new Date('2026-09-11T09:20:00.000Z');
    const dto = mapUserToDto(
      {
        _id: '6712f0b1c9a41d2f8e4b3a04',
        email: 'ada@acme.example',
        displayName: 'Ada',
        userStatus: 'active',
        passwordUpdatedAt: completedAt,
        createdAt: completedAt,
      },
      [],
    );
    expect(dto.passwordResetStatus).toBe('completed');
    expect(dto.passwordResetCompletedAt).toBe(completedAt.toISOString());
  });

  it('detects forbidden secret keys nested in objects', () => {
    expect(containsForbiddenSecretKey({ nested: { passwordHash: 'x' } })).toBe(true);
    expect(containsForbiddenSecretKey({ id: '1' })).toBe(false);
  });
});
