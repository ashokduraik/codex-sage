/**
 * Administrator-set password route (D15).
 * Interim users.manage guard until Phase 09 requirePermissions.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { adminSetPassword } from '../auth/password.service.js';
import { PASSWORD_MIN_LENGTH } from '../auth/passwordPolicy.js';
import { findMembership } from './membership.repository.js';
import { Role } from './role.model.js';

const resetBodySchema = z.object({
  newPassword: z.string().min(1).max(1024),
});

/**
 * True when the principal may manage users (interim until Phase 09).
 * Allows built-in org_admin or any role that already lists `users.manage`.
 * @param {string} orgId Tenant id.
 * @param {string} userId Actor user id.
 * @returns {Promise<boolean>}
 */
async function actorHasUsersManage(orgId, userId) {
  const membership = await findMembership(orgId, userId);
  if (!membership?.roleIds?.length) {
    return false;
  }
  const roles = await Role.find({
    _id: { $in: membership.roleIds },
    orgId,
  }).exec();
  return roles.some(
    (role) =>
      role.builtInKey === 'org_admin' ||
      (Array.isArray(role.permissions) && role.permissions.includes('users.manage')),
  );
}

/**
 * Registers `POST /users/:userId/reset-password`.
 * @param {import('fastify').FastifyInstance} app Fastify app with auth decorations.
 */
export async function adminPasswordResetRoutes(app) {
  const authenticate = app.authenticate;

  app.post(
    '/users/:userId/reset-password',
    {
      config: {
        rateLimitClass: 'auth',
        requiredPermissions: ['users.manage'],
      },
      preHandler: authenticate,
    },
    async (request) => {
      const principal = request.principal;
      const allowed = await actorHasUsersManage(principal.orgId, principal.userId);
      if (!allowed) {
        throw ApiError.fromCode('FORBIDDEN');
      }

      const targetUserId = request.params.userId;
      if (typeof targetUserId !== 'string' || !targetUserId) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'userId', message: 'userId is required' }],
        });
      }

      const parsed = resetBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      if (parsed.data.newPassword.length < PASSWORD_MIN_LENGTH) {
        throw ApiError.fromCode('PASSWORD_POLICY_VIOLATION', {
          details: { violations: ['TOO_SHORT'] },
        });
      }

      const result = await adminSetPassword(
        {
          orgId: principal.orgId,
          actorUserId: principal.userId,
          targetUserId,
          newPassword: parsed.data.newPassword,
        },
        { log: request.log },
      );

      if (result.outcome === 'not_found') {
        throw ApiError.fromCode('NOT_FOUND', { message: 'User not found.' });
      }
      if (result.outcome === 'policy_violation') {
        throw ApiError.fromCode('PASSWORD_POLICY_VIOLATION', {
          details: { violations: result.violations ?? [] },
        });
      }
      if (result.outcome !== 'password_changed' || !result.passwordUpdatedAt) {
        throw ApiError.fromCode('INTERNAL_ERROR');
      }

      return {
        userId: result.userId,
        passwordResetStatus: 'completed',
        completedAt: result.passwordUpdatedAt.toISOString(),
        sessionsRevoked: true,
        deliveryChannel: 'administrator',
      };
    },
  );
}
