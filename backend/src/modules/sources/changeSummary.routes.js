/**
 * Latest source change-summary HTTP route (knowledge updates URL).
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { loadLatestChangeSummary } from './changeSummary.service.js';

/**
 * Registers GET /projects/:projectId/knowledge/updates/latest under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function changeSummaryRoutes(app) {
  app.get(
    '/projects/:projectId/knowledge/updates/latest',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission(['knowledge.browse', 'knowledge.view'], {
        mode: 'any',
      }),
    },
    async (request) =>
      loadLatestChangeSummary({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
      }),
  );
}
