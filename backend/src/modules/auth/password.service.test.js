/**
 * Unit tests for password service helpers and outcomes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../platform/errors.js';

vi.mock('../identity/user.repository.js', () => ({
  findUserById: vi.fn(),
  findUserByIdWithPassword: vi.fn(),
  applyPasswordUpdate: vi.fn(),
}));
vi.mock('./passwordHasher.js', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  verifyPassword: vi.fn(),
}));
vi.mock('./session.repository.js', () => ({
  revokeAllSessionsForUser: vi.fn(async () => ({})),
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

import {
  applyPasswordUpdate,
  findUserById,
  findUserByIdWithPassword,
} from '../identity/user.repository.js';
import { verifyPassword } from './passwordHasher.js';
import {
  adminSetPassword,
  changeOwnPassword,
  getPasswordResetStatus,
} from './password.service.js';

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
    findUserByIdWithPassword.mockResolvedValue({ passwordHash: null });
    const result = await changeOwnPassword({
      orgId: 'o1',
      userId: 'u1',
      currentPassword: 'x',
      newPassword: 'abcdef',
    });
    expect(result.outcome).toBe('not_found');
  });

  it('returns policy_violation when applyNewPassword rejects the candidate', async () => {
    findUserByIdWithPassword.mockResolvedValue({ passwordHash: 'old' });
    verifyPassword.mockResolvedValueOnce(true);
    verifyPassword.mockResolvedValueOnce(true);
    findUserById.mockResolvedValue({
      _id: 'u1',
      userStatus: 'active',
    });

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
    findUserByIdWithPassword.mockResolvedValue({ passwordHash: 'old' });
    verifyPassword
      .mockResolvedValueOnce(true) // current password ok
      .mockResolvedValueOnce(false); // not SAME_AS_CURRENT
    findUserById.mockResolvedValue({ _id: 'u1', userStatus: 'active' });
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
    findUserByIdWithPassword.mockResolvedValue({
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
    findUserByIdWithPassword.mockResolvedValue({
      _id: 'u2',
      passwordHash: 'hash',
      userStatus: 'active',
    });
    verifyPassword.mockResolvedValue(false);
    findUserById.mockResolvedValue({ _id: 'u2', userStatus: 'active' });
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
