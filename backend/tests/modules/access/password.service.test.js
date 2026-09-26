/**
 * Unit tests for password service helpers and outcomes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';

vi.mock('../../../src/modules/masters/index.js', () => ({
  findUserById: vi.fn(),
  findUserByIdWithPassword: vi.fn(),
  applyPasswordUpdate: vi.fn(),
}));
vi.mock('../../../src/modules/access/auth.js', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  verifyPassword: vi.fn(),
  revokeAllLoginSessionsForUser: vi.fn(async () => ({})),
}));
vi.mock('mongoose', async () => {
  const actual = await vi.importActual('mongoose');
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

import { User } from '../../../src/models/user.model.js';
import { applyPasswordUpdate, findUserById, findUserByIdWithPassword } from '../../../src/modules/masters/index.js';
import { verifyPassword } from '../../../src/modules/access/auth.js';

/**
 * @param {object | null} doc User document.
 * @returns {void}
 */
function mockUserLookup(doc) {
  findUserById.mockResolvedValue(doc);
  findUserByIdWithPassword.mockResolvedValue(doc);
  vi.spyOn(User, 'findOne').mockReturnValue({
    select() {
      return this;
    },
    session() {
      return this;
    },
    exec: vi.fn().mockResolvedValue(doc),
  });
}
import { adminSetPassword, changeOwnPassword, getPasswordResetStatus } from '../../../src/modules/access/password.js';

describe('getPasswordResetStatus', () => {
  it('returns none when passwordUpdatedAt is missing', () => {
    expect(getPasswordResetStatus({})).toEqual({ state: 'none', completedAt: null });
    expect(getPasswordResetStatus({ passwordUpdatedAt: null })).toEqual({
      state: 'none',
      completedAt: null,
    });
  });

  it('returns completed from passwordUpdatedAt', () => {
    const when = new Date('2026-05-04T09:12:00.000Z');
    expect(getPasswordResetStatus({ passwordUpdatedAt: when })).toEqual({
      state: 'completed',
      completedAt: '2026-05-04T09:12:00.000Z',
    });
  });
});

describe('changeOwnPassword / adminSetPassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_found when the user has no password hash', async () => {
    mockUserLookup({ passwordHash: null });
    const result = await changeOwnPassword({
      orgId: 'o1',
      userId: 'u1',
      currentPassword: 'x',
      newPassword: 'abcdef',
    });
    expect(result.outcome).toBe('not_found');
  });

  it('returns policy_violation when applyNewPassword rejects the candidate', async () => {
    mockUserLookup({ passwordHash: 'old', _id: 'u1', userStatus: 'active' });
    verifyPassword.mockResolvedValueOnce(true);
    verifyPassword.mockResolvedValueOnce(true);

    const result = await changeOwnPassword({
      orgId: 'o1',
      userId: 'u1',
      currentPassword: 'abcdef',
      newPassword: 'abcdef',
    });
    expect(result.outcome).toBe('policy_violation');
    expect(result.violations).toContain('SAME_AS_CURRENT');
  });

  it('rethrows non-policy errors from applyNewPassword', async () => {
    mockUserLookup({ passwordHash: 'old', _id: 'u1', userStatus: 'active' });
    verifyPassword
      .mockResolvedValueOnce(true) // current password ok
      .mockResolvedValueOnce(false); // not SAME_AS_CURRENT
    applyPasswordUpdate.mockRejectedValue(ApiError.fromCode('INTERNAL_ERROR'));

    await expect(
      changeOwnPassword({
        orgId: 'o1',
        userId: 'u1',
        currentPassword: 'oldpass',
        newPassword: 'newpass',
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('adminSetPassword returns policy_violation for short passwords', async () => {
    mockUserLookup({
      _id: 'u2',
      passwordHash: 'hash',
      userStatus: 'active',
    });
    const result = await adminSetPassword({
      orgId: 'o1',
      actorUserId: 'u1',
      targetUserId: 'u2',
      newPassword: 'ab',
    });
    expect(result.outcome).toBe('policy_violation');
    expect(result.violations).toContain('TOO_SHORT');
  });

  it('adminSetPassword rethrows unexpected errors', async () => {
    mockUserLookup({
      _id: 'u2',
      passwordHash: 'hash',
      userStatus: 'active',
    });
    verifyPassword.mockResolvedValue(false);
    applyPasswordUpdate.mockRejectedValue(new Error('boom'));

    await expect(
      adminSetPassword({
        orgId: 'o1',
        actorUserId: 'u1',
        targetUserId: 'u2',
        newPassword: 'abcdef',
      }),
    ).rejects.toThrow('boom');
  });
});
