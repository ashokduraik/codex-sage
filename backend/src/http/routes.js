import { healthRoutes } from '../modules/health/health.routes.js';
/**
 * Fastify plugin that registers every domain route module.
 * All routes are mounted under `API_BASE_PATH` (see `http/app.ts`).
 * @param app - The Fastify application instance.
 */
export async function registerRoutes(app) {
    await app.register(healthRoutes);
}
