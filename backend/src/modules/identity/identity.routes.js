/**
 * Identity admin HTTP routes — users, roles, memberships, admin set-password.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { buildAuditContextFromRequest, recordAuditEvent } from '../audit/index.js';
import { adminSetPassword } from '../auth/password.service.js';
import { PASSWORD_MIN_LENGTH } from '../auth/passwordPolicy.js';
import {
  createRoleBodySchema,
  createUserBodySchema,
  listRolesQuerySchema,
  listUsersQuerySchema,
  patchRoleBodySchema,
  patchUserBodySchema,
  replaceRolesBodySchema,
  roleIdParamsSchema,
  userIdParamsSchema,
} from './identity.schemas.js';
import { replaceUserRoles } from './membership.service.js';
import {
  createRole,
  listRolesForOrg,
  softDeleteRole,
  updateRole,
} from './role.service.js';
import {
  activateUser,
  createUser,
  deactivateUser,
  getUser,
  listUsers,
  removeUser,
  updateUserDetails,
} from './user.service.js';

const resetBodySchema = z
  .object({
    newPassword: z.string().min(1).max(1024),
  })
  .strict();

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || 'body',
    message: issue.message,
  }));
}

/**
 * Shared request context for identity services.
 * @param {import('fastify').FastifyRequest} request Request.
 * @returns {{
 *   orgId: string,
 *   actorUserId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log: import('fastify').FastifyBaseLogger,
 * }}
 */
function serviceContext(request) {
  const audit = buildAuditContextFromRequest(request);
  return {
    orgId: /** @type {string} */ (request.principal.orgId),
    actorUserId: /** @type {string} */ (request.principal.userId),
    correlationId: audit.correlationId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    log: request.log,
  };
}

/**
 * Registers identity admin routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function identityRoutes(app) {
  app.post(
    '/users',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request, reply) => {
      const parsed = createUserBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      const user = await createUser({
        ...ctx,
        email: parsed.data.email,
        displayName: parsed.data.displayName,
        roleIds: parsed.data.roleIds,
      });
      return reply.code(201).send(user);
    },
  );

  app.get(
    '/users',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const parsed = listUsersQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      if (parsed.data.limit === 0) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'limit', message: 'limit must be a positive integer' }],
        });
      }
      return listUsers(request.principal.orgId, parsed.data);
    },
  );

  app.get(
    '/users/:userId',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      return getUser(request.principal.orgId, params.data.userId);
    },
  );

  app.patch(
    '/users/:userId',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = patchUserBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      return updateUserDetails({
        ...ctx,
        targetUserId: params.data.userId,
        displayName: parsed.data.displayName,
        email: parsed.data.email,
        roleIds: parsed.data.roleIds,
      });
    },
  );

  app.post(
    '/users/:userId/activate',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      return activateUser({ ...ctx, targetUserId: params.data.userId });
    },
  );

  app.post(
    '/users/:userId/deactivate',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      return deactivateUser({ ...ctx, targetUserId: params.data.userId });
    },
  );

  app.delete(
    '/users/:userId',
    { config: { requiredPermissions: ['users.manage'] } },
    async (request, reply) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      await removeUser({ ...ctx, targetUserId: params.data.userId });
      return reply.code(204).send();
    },
  );

  app.put(
    '/users/:userId/roles',
    {
      config: {
        requiredPermissions: ['users.manage', 'roles.manage'],
      },
    },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = replaceRolesBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      return replaceUserRoles({
        ...ctx,
        targetUserId: params.data.userId,
        roleIds: parsed.data.roleIds,
      });
    },
  );

  app.post(
    '/users/:userId/reset-password',
    {
      config: {
        rateLimitClass: 'auth',
        requiredPermissions: ['users.manage'],
      },
    },
    async (request) => {
      const params = userIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: zodDetails(params.error),
        });
      }
      const parsed = resetBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      if (parsed.data.newPassword.length < PASSWORD_MIN_LENGTH) {
        throw ApiError.fromCode('PASSWORD_POLICY_VIOLATION', {
          details: { violations: ['TOO_SHORT'] },
        });
      }

      const principal = request.principal;
      const auditBase = buildAuditContextFromRequest(request);
      const result = await adminSetPassword(
        {
          orgId: principal.orgId,
          actorUserId: principal.userId,
          targetUserId: params.data.userId,
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
          resourceId: String(result.userId ?? params.data.userId),
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

  app.get(
    '/roles',
    { config: { requiredPermissions: ['roles.manage'] } },
    async (request) => {
      const parsed = listRolesQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      if (parsed.data.limit === 0) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'limit', message: 'limit must be a positive integer' }],
        });
      }
      return listRolesForOrg(request.principal.orgId, parsed.data);
    },
  );

  app.post(
    '/roles',
    { config: { requiredPermissions: ['roles.manage'] } },
    async (request, reply) => {
      const parsed = createRoleBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      const role = await createRole({
        ...ctx,
        name: parsed.data.name,
        description: parsed.data.description,
        permissions: parsed.data.permissions,
      });
      return reply.code(201).send(role);
    },
  );

  app.patch(
    '/roles/:roleId',
    { config: { requiredPermissions: ['roles.manage'] } },
    async (request) => {
      const params = roleIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = patchRoleBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      return updateRole({
        ...ctx,
        roleId: params.data.roleId,
        name: parsed.data.name,
        description: parsed.data.description,
        permissions: parsed.data.permissions,
      });
    },
  );

  app.delete(
    '/roles/:roleId',
    { config: { requiredPermissions: ['roles.manage'] } },
    async (request, reply) => {
      const params = roleIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      await softDeleteRole({ ...ctx, roleId: params.data.roleId });
      return reply.code(204).send();
    },
  );
}

/** @deprecated Prefer {@link identityRoutes}; kept for existing unit tests. */
export { identityRoutes as adminPasswordResetRoutes };
