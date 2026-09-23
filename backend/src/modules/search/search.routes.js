/**
 * Project search HTTP route under `/api/v1/projects/:projectId/search`.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { runProjectSearchFromQuery } from './search.service.js';

/**
 * Registers search routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function searchRoutes(app) {
  app.get(
    '/projects/:projectId/search',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('search.run'),
    },
    async (request) =>
      runProjectSearchFromQuery({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
        workspaceRoot: request.server.config.workspace.root,
        query: request.query,
      }),
  );
}
