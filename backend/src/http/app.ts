/**
 * Builds and configures the Fastify application instance.
 * Registers platform concerns (error handling, structured logging, CORS) and
 * domain routes. Does not start listening — call `.listen()` on the returned
 * instance (see `index.ts`).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig, type AppConfig } from '../platform/config';
import { buildLoggerOptions, registerRequestLogging } from '../platform/logger';
import { registerErrorHandler } from '../platform/errors';
import { registerRoutes } from './routes';
import { healthRoutes } from '../modules/health/health.routes';

/** Versioned API route prefix — product contract, not an env var. */
export const API_BASE_PATH = '/api/v1';

/**
 * Extends the Fastify instance type so all route handlers can access `app.config`
 * without unsafe casts.
 */
declare module 'fastify' {
  interface FastifyInstance {
    /** Resolved application configuration, decorated at startup. */
    config: AppConfig;
  }
}

/**
 * Builds and configures the Fastify application instance.
 * Registers platform concerns (error handling, structured logging, CORS) and
 * domain routes. Does not start listening — call `.listen()` on the returned
 * instance (see `index.ts`).
 * @param config - Application configuration; defaults to reading from environment variables.
 * @returns A configured, ready-to-listen Fastify instance.
 */
export function buildApp(config: AppConfig = loadConfig()): FastifyInstance {
  const app = Fastify({
    logger: buildLoggerOptions(config),
    disableRequestLogging: true,
  });

  if (config.logging.logger) {
    registerRequestLogging(app);
  }

  app.decorate('config', config);

  // CORS: allow all origins in non-production environments for local dev convenience.
  if (!config.env.isProduction) {
    void app.register(cors, {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
    });
  }

  registerErrorHandler(app);

  // Unversioned infra aliases (same handlers as under API_BASE_PATH).
  void app.register(healthRoutes);

  void app.register(registerRoutes, { prefix: API_BASE_PATH });

  return app;
}
