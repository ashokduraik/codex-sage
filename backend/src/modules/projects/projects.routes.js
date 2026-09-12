/**
 * Project HTTP routes under `/api/v1`.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { buildAuditContextFromRequest } from '../audit/index.js';
import {
  archiveProject,
  createProject,
  deleteProject,
  getDeletionPreview,
  getProject,
  getProjectSettings,
  listProjects,
  patchProjectSettings,
  restoreProject,
  updateProject,
} from './projects.service.js';

const createBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    sourceType: z.enum(['upload', 'repository']),
  });
  // Unknown keys (e.g. forged orgId) are stripped — never trusted from the client.

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'At least one of name or description is required',
  });

const settingsBodySchema = z
  .object({
    settings: z.record(z.string(), z.unknown()),
  })
  .strict();

const listQuerySchema = z.object({
  q: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => value === true || value === 'true'),
});
// Unknown query keys (e.g. forged orgId) are stripped.

const projectIdParamsSchema = z.object({
  projectId: z.string().min(1),
});

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
 * Shared request context for project services.
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
 * Registers project routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function projectRoutes(app) {
  app.post(
    '/projects',
    {
      config: {
        requiredPermissions: ['projects.create'],
        requireIdempotencyKey: true,
      },
    },
    async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      const project = await createProject({
        ...ctx,
        name: parsed.data.name,
        description: parsed.data.description,
        sourceType: parsed.data.sourceType,
      });
      return reply.code(201).send(project);
    },
  );

  app.get(
    '/projects',
    { config: { requiredPermissions: ['projects.view'] } },
    async (request) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      if (parsed.data.limit === 0) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'limit', message: 'limit must be a positive integer' }],
        });
      }
      return listProjects(request.principal.orgId, request.principal.userId, parsed.data);
    },
  );

  app.get(
    '/projects/:projectId',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('projects.view'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      return getProject(request.projectScope.orgId, request.projectScope.projectId);
    },
  );

  app.patch(
    '/projects/:projectId',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('projects.update'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = patchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      return updateProject({
        ...ctx,
        projectId: request.projectScope.projectId,
        name: parsed.data.name,
        description: parsed.data.description,
      });
    },
  );

  app.get(
    '/projects/:projectId/settings',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('settings.manage'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      return getProjectSettings(request.projectScope.orgId, request.projectScope.projectId);
    },
  );

  app.patch(
    '/projects/:projectId/settings',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('settings.manage'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = settingsBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      return patchProjectSettings({
        ...ctx,
        projectId: request.projectScope.projectId,
        settings: parsed.data.settings,
      });
    },
  );

  app.post(
    '/projects/:projectId/archive',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('projects.update'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      return archiveProject({ ...ctx, projectId: request.projectScope.projectId });
    },
  );

  app.post(
    '/projects/:projectId/restore',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('projects.update'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      return restoreProject({ ...ctx, projectId: request.projectScope.projectId });
    },
  );

  app.get(
    '/projects/:projectId/deletion-preview',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('projects.delete'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      return getDeletionPreview(
        request.projectScope.orgId,
        request.projectScope.projectId,
      );
    },
  );

  app.delete(
    '/projects/:projectId',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('projects.delete'),
    },
    async (request, reply) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      await deleteProject({ ...ctx, projectId: request.projectScope.projectId });
      return reply.code(204).send();
    },
  );
}
