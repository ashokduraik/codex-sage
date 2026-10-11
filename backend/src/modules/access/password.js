/**
 * access/password.js — merged resource file.
 */
import { z } from 'zod';
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import { buildAuditContextFromRequest, recordAuditEvent } from './audit.js';
import { hashPassword, verifyPassword, revokeAllLoginSessionsForUser } from './auth.js';
import { applyPasswordUpdate, findUserById, findUserByIdWithPassword } from '../masters/index.js';

// --- from auth/passwordPolicy.js ---
/**
 * Password policy — returns machine-readable violation codes for UI localisation.
 */

/** Minimum accepted password length (locked Phase 08). */
export const PASSWORD_MIN_LENGTH = 6;

/**
 * Number of previous hashes checked for reuse. `0` disables history storage and checks.
 */
export const PASSWORD_HISTORY_LENGTH = 0;

/**
 * @typedef {'TOO_SHORT' | 'SAME_AS_CURRENT' | 'RECENTLY_USED'} PasswordPolicyViolation
 */

/**
 * Validates a candidate password against the policy.
 * @param {string} candidate Plaintext candidate.
 * @param {{
 *   currentHash?: string | null,
 *   verifyPassword?: (hash: string, password: string) => Promise<boolean>,
 * }} [options] Optional current-hash check.
 * @returns {Promise<PasswordPolicyViolation[]>}
 */
export async function validatePasswordCandidate(candidate, options = {}) {
  /** @type {PasswordPolicyViolation[]} */
  const violations = [];
  if (typeof candidate !== 'string' || candidate.length < PASSWORD_MIN_LENGTH) {
    violations.push('TOO_SHORT');
  }

  if (options.currentHash && typeof options.verifyPassword === 'function' && candidate.length > 0) {
    const matchesCurrent = await options.verifyPassword(options.currentHash, candidate);
    if (matchesCurrent) {
      violations.push('SAME_AS_CURRENT');
    }
  }

  // PASSWORD_HISTORY_LENGTH === 0: no RECENTLY_USED check and no history storage.
  return violations;
}

// --- from auth/password.service.js ---
/**
 * Password change and admin-set flows — single transactional write path.
 */
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
      await revokeAllLoginSessionsForUser(input.orgId, input.userId, 'password_changed', {
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
        err.details && typeof err.details === 'object' && Array.isArray(/** @type {{ violations?: unknown }} */ (err.details).violations)
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
    ctx.log?.info?.({ outcome: 'password_changed', targetUserId: String(input.targetUserId) }, 'admin password set succeeded');
    return {
      ...result,
      userId: String(input.targetUserId),
    };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'PASSWORD_POLICY_VIOLATION') {
      const violations =
        err.details && typeof err.details === 'object' && Array.isArray(/** @type {{ violations?: unknown }} */ (err.details).violations)
          ? /** @type {{ violations: string[] }} */ (err.details).violations
          : [];
      ctx.log?.info?.({ outcome: 'policy_violation' }, 'admin password set rejected');
      return { outcome: 'policy_violation', violations };
    }
    throw err;
  }
}

// --- from auth/password.routes.js ---
/**
 * Self-service password change routes.
 */
const changeBodySchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});

/**
 * Registers `POST /auth/password/change`.
 * @param {import('fastify').FastifyInstance} app Fastify app with auth decorations.
 */
export async function passwordRoutes(app) {
  app.post(
    '/auth/password/change',
    {
      config: {
        routeAccess: 'authenticated',
        allowWhenMustChangePassword: true,
      },
    },
    async (request) => {
      const parsed = changeBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      // Surface min-length early for empty-ish candidates; policy still runs in the service.
      if (parsed.data.newPassword.length < PASSWORD_MIN_LENGTH) {
        throw ApiError.fromCode('PASSWORD_POLICY_VIOLATION', {
          details: { violations: ['TOO_SHORT'] },
        });
      }

      const principal = request.principal;
      const auditBase = buildAuditContextFromRequest(request);
      const result = await changeOwnPassword(
        {
          orgId: principal.orgId,
          userId: principal.userId,
          currentPassword: parsed.data.currentPassword,
          newPassword: parsed.data.newPassword,
        },
        { log: request.log },
      );

      if (result.outcome === 'invalid_current_password') {
        await recordAuditEvent(
          {
            ...auditBase,
            orgId: principal.orgId,
            actorUserId: principal.userId,
            action: 'user.password_changed',
            resourceType: 'user',
            resourceId: principal.userId,
            result: 'failed',
            context: { reason: 'self_change', failure: 'invalid_current_password' },
          },
          { log: request.log },
        );
        throw ApiError.fromCode('INVALID_CURRENT_PASSWORD');
      }
      if (result.outcome === 'policy_violation') {
        throw ApiError.fromCode('PASSWORD_POLICY_VIOLATION', {
          details: { violations: result.violations ?? [] },
        });
      }
      if (result.outcome !== 'password_changed') {
        throw ApiError.fromCode('UNAUTHENTICATED');
      }

      await recordAuditEvent(
        {
          ...auditBase,
          orgId: principal.orgId,
          actorUserId: principal.userId,
          action: 'user.password_changed',
          resourceType: 'user',
          resourceId: principal.userId,
          result: 'success',
          context: { reason: 'self_change', sessionsRevoked: true },
        },
        { log: request.log },
      );

      return {
        passwordChanged: true,
        sessionsRevoked: true,
        reauthenticationRequired: true,
      };
    },
  );
}
