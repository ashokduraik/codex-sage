/**
 * Source version HTTP routes under `/api/v1` (reingest).
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { enqueueSourceReingest } from './sources.service.js';

/**
 * Registers source version routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function sourceRoutes(app) {
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
