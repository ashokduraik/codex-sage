/**
 * Permission catalog HTTP routes.
 */
import { toPermissionsApiPayload } from './permissionCatalog.js';

/**
 * Registers `GET /permissions`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function permissionsRoutes(app) {
  app.get(
    '/permissions',
    {
      config: {
        requiredPermissions: ['roles.manage'],
      },
    },
    async () => toPermissionsApiPayload(),
  );
}
