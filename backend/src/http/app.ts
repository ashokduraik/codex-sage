import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { loadConfig, type AppConfig } from '../platform/config';
import { buildLoggerOptions, registerRequestLogging } from '../platform/logger';
import { registerErrorHandler } from '../platform/errors';
import { registerRoutes } from './routes';

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

  if (config.logger) {
    registerRequestLogging(app);
  }

  app.decorate('config', config);

  // CORS: allow all origins in non-production environments for local dev convenience.
  if (config.nodeEnv !== 'production') {
    void app.register(cors, {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type'],
    });
  }

  registerErrorHandler(app);

  void app.register(registerRoutes, { prefix: '/api' });

  return app;
}
