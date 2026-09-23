import { healthRoutes } from '../modules/health/health.routes.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { passwordRoutes } from '../modules/auth/password.routes.js';
import { identityRoutes } from '../modules/identity/identity.routes.js';
import { permissionsRoutes } from '../modules/authorization/permissions.routes.js';
import { auditRoutes } from '../modules/audit/index.js';
import { projectRoutes } from '../modules/projects/index.js';
import { projectMemberRoutes } from '../modules/projectMembers/index.js';
import { jobRoutes } from '../modules/jobs/index.js';
import { repositoryRoutes } from '../modules/repositories/index.js';
import { sourceRoutes, sourceUploadRoutes } from '../modules/sources/index.js';

/**
 * Fastify plugin that registers every domain route module.
 * All routes are mounted under `API_BASE_PATH` (see `http/app.js`).
 * @param {import('fastify').FastifyInstance} app The Fastify application instance.
 */
export async function registerRoutes(app) {
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(passwordRoutes);
  await app.register(identityRoutes);
  await app.register(permissionsRoutes);
  await app.register(auditRoutes);
  await app.register(projectRoutes);
  await app.register(projectMemberRoutes);
  await app.register(jobRoutes);
  await app.register(sourceUploadRoutes);
  await app.register(sourceRoutes);
  await app.register(repositoryRoutes);
}
