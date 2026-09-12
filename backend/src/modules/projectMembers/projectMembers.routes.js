/**
 * Project members HTTP routes under `/api/v1`.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { buildAuditContextFromRequest } from '../audit/index.js';
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import {
  addProjectMember,
  listMembers,
  removeProjectMember,
} from './projectMembers.service.js';

const projectIdParamsSchema = z.object({
  projectId: z.string().min(1),
});

const memberUserParamsSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
});

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
});

const addBodySchema = z
  .object({
    userId: z.string().min(1),
    roleId: z.string().min(1).nullable().optional(),
    permissions: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      for (const key of issue.keys) {
        details.push({ path: String(key), message: 'Unrecognized key' });
      }
      continue;
    }
    details.push({
      path: issue.path.join('.') || 'body',
      message: issue.message,
    });
  }
  return details;
}

/**
 * Shared request context for member services.
 * @param {import('fastify').FastifyRequest} request Request.
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

/** Members manage: projects.update on the project OR org-level users.manage. */
const requireMembersManage = requireProjectPermission(
  ['projects.update', 'users.manage'],
  { mode: 'any' },
);

/**
 * Registers project member routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function projectMemberRoutes(app) {
  app.get(
    '/projects/:projectId/members',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireMembersManage,
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const query = listQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(query.error) });
      }
      if (query.data.limit === 0) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'limit', message: 'limit must be a positive integer' }],
        });
      }
      return listMembers(request.principal.orgId, params.data.projectId, query.data);
    },
  );

  app.post(
    '/projects/:projectId/members',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireMembersManage,
    },
    async (request, reply) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = addBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      const result = await addProjectMember({
        ...ctx,
        projectId: params.data.projectId,
        userId: parsed.data.userId,
        roleId: parsed.data.roleId,
        permissions: parsed.data.permissions,
      });
      return reply.code(result.created ? 201 : 200).send(result.member);
    },
  );

  app.delete(
    '/projects/:projectId/members/:userId',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireMembersManage,
    },
    async (request, reply) => {
      const params = memberUserParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      await removeProjectMember({
        ...ctx,
        projectId: params.data.projectId,
        userId: params.data.userId,
      });
      return reply.code(204).send();
    },
  );
}
