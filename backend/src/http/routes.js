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
import {
  changeSummaryRoutes,
  sourcePreviewRoutes,
  sourceRoutes,
  sourceUploadRoutes,
} from '../modules/sources/index.js';
import { knowledgeBrowseRoutes } from '../modules/knowledge/index.js';
import { searchRoutes } from '../modules/search/index.js';
import { conversationRoutes } from '../modules/conversations/index.js';

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
  await app.register(sourcePreviewRoutes);
  await app.register(changeSummaryRoutes);
  await app.register(repositoryRoutes);
  await app.register(knowledgeBrowseRoutes);
  await app.register(searchRoutes);
  await app.register(conversationRoutes);
}
