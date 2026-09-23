/**
 * Source version HTTP routes under `/api/v1` (list + reingest).
 */
import { z } from 'zod';
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { ApiError } from '../../platform/errors.js';
import { enqueueSourceReingest, listProjectSourceVersions } from './sources.service.js';

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
});

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
    details.push({
      path: issue.path.join('.') || 'query',
      message: issue.message,
    });
  }
  return details;
}

/**
 * Registers source version routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function sourceRoutes(app) {
  app.get(
    '/projects/:projectId/source-versions',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('projects.view'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      if (parsed.data.limit === 0) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'limit', message: 'limit must be a positive integer' }],
        });
      }
      return listProjectSourceVersions(
        request.projectScope.orgId,
        request.projectScope.projectId,
        parsed.data,
      );
    },
  );

  app.post(
    '/projects/:projectId/sources/:sourceVersionId/reingest',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
      },
      preHandler: requireProjectPermission('knowledge.trigger'),
    },
    async (request, reply) => {
      const result = await enqueueSourceReingest({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        sourceVersionId: String(request.params.sourceVersionId),
        actorUserId: request.projectScope.userId,
        correlationId: request.id,
      });
      return reply.code(202).send(result);
    },
  );
}
