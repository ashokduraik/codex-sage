/**
 * Password change and admin-set flows — single transactional write path.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import {
  applyPasswordUpdate,
  findUserById,
  findUserByIdWithPassword,
} from '../identity/user.repository.js';
import { hashPassword, verifyPassword } from './passwordHasher.js';
import { validatePasswordCandidate } from './passwordPolicy.js';
import { revokeAllSessionsForUser } from './session.repository.js';

/**
 * @typedef {'self_change' | 'admin_set'} PasswordChangeReason
 */

/**
 * @typedef {'password_changed' | 'invalid_current_password' | 'policy_violation' | 'not_found'} PasswordOutcomeCode
 */

/**
 * Builds the Phase 11 reset-status read model from a user document.
 * @param {{ passwordUpdatedAt?: Date | null }} user User fields.
 * @returns {{ state: 'none' | 'completed', completedAt: string | null }}
 */
export function getPasswordResetStatus(user) {
  if (user?.passwordUpdatedAt instanceof Date) {
    return {
      state: 'completed',
      completedAt: user.passwordUpdatedAt.toISOString(),
    };
  }
  return { state: 'none', completedAt: null };
}

/**
 * Validates, hashes, persists, and revokes sessions for a new password.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   userId: import('mongoose').Types.ObjectId | string,
 *   newPassword: string,
 *   reason: PasswordChangeReason,
 *   actorUserId: import('mongoose').Types.ObjectId | string,
 *   currentHash?: string | null,
 * }} input Apply inputs.
 * @returns {Promise<{
 *   outcome: 'password_changed',
 *   passwordUpdatedAt: Date,
 *   sessionsRevoked: true,
 *   mustChangePassword: boolean,
 * }>}
 * @throws {ApiError} On policy violation.
 */
export async function applyNewPassword(input) {
  const violations = await validatePasswordCandidate(input.newPassword, {
    currentHash: input.currentHash,
    verifyPassword,
  });
  if (violations.length > 0) {
    throw ApiError.fromCode('PASSWORD_POLICY_VIOLATION', {
      details: { violations },
    });
  }

  const nextHash = await hashPassword(input.newPassword);
  const mustChangePassword = input.reason === 'admin_set';
  const target = await findUserById(input.orgId, input.userId);
  if (!target) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
  }

  /** @type {string | undefined} */
  let nextUserStatus;
  if (target.userStatus === 'invited') {
    nextUserStatus = 'active';
  }

  const mongoSession = await mongoose.startSession();
  try {
    /** @type {Date | undefined} */
    let passwordUpdatedAt;
    await mongoSession.withTransaction(async () => {
      const updated = await applyPasswordUpdate(
        input.orgId,
        input.userId,
        {
          passwordHash: nextHash,
          mustChangePassword,
          userStatus: nextUserStatus,
          updatedBy: input.actorUserId,
        },
        { session: mongoSession },
      );
      if (!updated.matched) {
        throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
      }
      passwordUpdatedAt = updated.passwordUpdatedAt;
      await revokeAllSessionsForUser(input.orgId, input.userId, 'password_changed', {
        session: mongoSession,
      });
    });
    if (!passwordUpdatedAt) {
      throw ApiError.fromCode('INTERNAL_ERROR');
    }
    return {
      outcome: 'password_changed',
      passwordUpdatedAt,
      sessionsRevoked: true,
      mustChangePassword,
    };
  } finally {
    await mongoSession.endSession();
  }
}

/**
 * Signed-in user changes their own password.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   userId: import('mongoose').Types.ObjectId | string,
 *   currentPassword: string,
 *   newPassword: string,
 * }} input Change inputs.
 * @param {{ log?: { info?: Function } }} [ctx] Optional logger for typed outcomes.
 * @returns {Promise<{
 *   outcome: PasswordOutcomeCode,
 *   passwordUpdatedAt?: Date,
 *   sessionsRevoked?: boolean,
 *   mustChangePassword?: boolean,
 *   violations?: string[],
 * }>}
 */
export async function changeOwnPassword(input, ctx = {}) {
  const user = await findUserByIdWithPassword(input.orgId, input.userId);
  if (!user || !user.passwordHash) {
    ctx.log?.info?.({ outcome: 'not_found' }, 'password change rejected');
    return { outcome: 'not_found' };
  }

  const currentOk = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!currentOk) {
    ctx.log?.info?.({ outcome: 'invalid_current_password' }, 'password change rejected');
    return { outcome: 'invalid_current_password' };
  }

  try {
    const result = await applyNewPassword({
      orgId: input.orgId,
      userId: input.userId,
      newPassword: input.newPassword,
      reason: 'self_change',
      actorUserId: input.userId,
      currentHash: user.passwordHash,
    });
    ctx.log?.info?.({ outcome: 'password_changed' }, 'password change succeeded');
    return result;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PASSWORD_POLICY_VIOLATION') {
      const violations =
        err.details &&
        typeof err.details === 'object' &&
        Array.isArray(/** @type {{ violations?: unknown }} */ (err.details).violations)
          ? /** @type {{ violations: string[] }} */ (err.details).violations
          : [];
      ctx.log?.info?.({ outcome: 'policy_violation' }, 'password change rejected');
      return { outcome: 'policy_violation', violations };
    }
    throw err;
  }
}

/**
 * Administrator sets a password for another user in the same organization.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   actorUserId: import('mongoose').Types.ObjectId | string,
 *   targetUserId: import('mongoose').Types.ObjectId | string,
 *   newPassword: string,
 * }} input Admin-set inputs.
 * @param {{ log?: { info?: Function } }} [ctx] Optional logger for typed outcomes.
 * @returns {Promise<{
 *   outcome: PasswordOutcomeCode,
 *   userId?: string,
 *   passwordUpdatedAt?: Date,
 *   sessionsRevoked?: boolean,
 *   mustChangePassword?: boolean,
 *   violations?: string[],
 * }>}
 */
export async function adminSetPassword(input, ctx = {}) {
  if (String(input.actorUserId) === String(input.targetUserId)) {
    throw ApiError.fromCode('CANNOT_MODIFY_SELF');
  }

  const target = await findUserByIdWithPassword(input.orgId, input.targetUserId);
  if (!target) {
    ctx.log?.info?.({ outcome: 'not_found' }, 'admin password set rejected');
    return { outcome: 'not_found' };
  }

  try {
    const result = await applyNewPassword({
      orgId: input.orgId,
      userId: input.targetUserId,
      newPassword: input.newPassword,
      reason: 'admin_set',
      actorUserId: input.actorUserId,
      currentHash: target.passwordHash ?? null,
    });
    ctx.log?.info?.(
      { outcome: 'password_changed', targetUserId: String(input.targetUserId) },
      'admin password set succeeded',
    );
    return {
      ...result,
      userId: String(input.targetUserId),
    };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PASSWORD_POLICY_VIOLATION') {
      const violations =
        err.details &&
        typeof err.details === 'object' &&
        Array.isArray(/** @type {{ violations?: unknown }} */ (err.details).violations)
          ? /** @type {{ violations: string[] }} */ (err.details).violations
          : [];
      ctx.log?.info?.({ outcome: 'policy_violation' }, 'admin password set rejected');
      return { outcome: 'policy_violation', violations };
    }
    throw err;
  }
}
