import { healthRoutes } from './health.routes.js';
import { authRoutes, passwordRoutes, permissionsRoutes, auditRoutes } from '../modules/access/index.js';
import { identityRoutes, projectRoutes, projectMemberRoutes, jobRoutes, notificationRoutes, usageRoutes } from '../modules/masters/index.js';
import {
  changeSummaryRoutes,
  sourcePreviewRoutes,
  sourceRoutes,
  sourceUploadRoutes,
  repositoryRoutes,
  knowledgeBrowseRoutes,
  searchRoutes,
} from '../modules/knowledge/index.js';
import { conversationContextRoutes, conversationRoutes } from '../modules/conversation/index.js';

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
  await app.register(conversationContextRoutes);
  await app.register(notificationRoutes);
  await app.register(usageRoutes);
}
