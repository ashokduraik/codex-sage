import { healthRoutes } from '../modules/health/health.routes.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { passwordRoutes } from '../modules/auth/password.routes.js';
import { adminPasswordResetRoutes } from '../modules/identity/adminPasswordReset.routes.js';

/**
 * Fastify plugin that registers every domain route module.
 * All routes are mounted under `API_BASE_PATH` (see `http/app.js`).
 * @param {import('fastify').FastifyInstance} app The Fastify application instance.
 */
export async function registerRoutes(app) {
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(passwordRoutes);
  await app.register(adminPasswordResetRoutes);
}
