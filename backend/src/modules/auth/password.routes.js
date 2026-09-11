/**
 * Self-service password change routes.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import {
  buildAuditContextFromRequest,
  recordAuditEvent,
} from '../audit/index.js';
import { changeOwnPassword } from './password.service.js';
import { PASSWORD_MIN_LENGTH } from './passwordPolicy.js';

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
