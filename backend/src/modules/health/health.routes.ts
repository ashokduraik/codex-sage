import type { FastifyInstance } from 'fastify';

/**
 * Liveness response for `GET /api/health`.
 * Local type until shared OpenAPI codegen exists.
 */
export interface HealthResponse {
  status: 'ok';
  service: 'api';
}

/**
 * Fastify plugin that registers the `/health` liveness route.
 * @param app - The Fastify application instance to register the route on.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (): Promise<HealthResponse> => {
    return { status: 'ok', service: 'api' };
  });
}
