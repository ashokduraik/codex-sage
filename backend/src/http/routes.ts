import type { FastifyInstance } from 'fastify';
import { healthRoutes } from '../modules/health/health.routes';

/**
 * Fastify plugin that registers every domain route module.
 * All routes are mounted under the `/api` prefix (see `http/app.ts`).
 * @param app - The Fastify application instance.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoutes);
}
