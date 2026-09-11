/**
 * Administrator-set password route (D15).
 * Guarded by requiredPermissions: users.manage (Phase 09 global authorize hook).
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import {
  buildAuditContextFromRequest,
  recordAuditEvent,
} from '../audit/index.js';
import { adminSetPassword } from '../auth/password.service.js';
import { PASSWORD_MIN_LENGTH } from '../auth/passwordPolicy.js';

const resetBodySchema = z.object({
  newPassword: z.string().min(1).max(1024),
});

/**
 * Registers `POST /users/:userId/reset-password`.
 * @param {import('fastify').FastifyInstance} app Fastify app with auth decorations.
 */
export async function adminPasswordResetRoutes(app) {
  app.post(
    '/users/:userId/reset-password',
    {
      config: {
        rateLimitClass: 'auth',
        requiredPermissions: ['users.manage'],
      },
    },
    async (request) => {
      const principal = request.principal;
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

      const auditBase = buildAuditContextFromRequest(request);
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

      await recordAuditEvent(
        {
          ...auditBase,
          orgId: principal.orgId,
          actorUserId: principal.userId,
          action: 'user.password_set_by_admin',
          resourceType: 'user',
          resourceId: String(result.userId ?? targetUserId),
          result: 'success',
          context: { reason: 'admin_set', sessionsRevoked: true },
        },
        { log: request.log },
      );

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
