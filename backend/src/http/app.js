/**
 * Builds and configures the Fastify application instance.
 * Registers platform concerns (error handling, structured logging, CORS) and
 * domain routes. Does not start listening — call `.listen()` on the returned
 * instance (see `index.js`).
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import csrf from '@fastify/csrf-protection';
import fjwt from '@fastify/jwt';
import { loadConfig } from '../platform/config.js';
import { buildLoggerOptions, registerRequestLogging } from '../platform/logger.js';
import { registerErrorHandler } from '../platform/errors.js';
import {
  generateCorrelationId,
  runWithRequestContext,
} from '../platform/requestContext.js';
import { createAuthenticatePreHandler } from '../modules/auth/authenticate.preHandler.js';
import { createAuthService } from '../modules/auth/auth.service.js';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_ACCESS_TOKEN_TTL_SECONDS,
} from '../modules/auth/tokenService.js';
import {
  assertAllRoutesDeclareAccess,
  createAuthorizePreHandler,
  installRouteDeclarationCollector,
} from '../modules/authorization/index.js';
import { registerIdempotency } from '../platform/idempotency/index.js';
import { registerRoutes } from './routes.js';
import { healthRoutes } from '../modules/health/health.routes.js';

/** Versioned API route prefix — product contract, not an env var. */
export const API_BASE_PATH = '/api/v1';
/** Response header carrying the request correlation reference. */
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';
/** CSRF header the browser must echo on refresh/logout. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Builds and configures the Fastify application instance.
 * Registers platform concerns (error handling, structured logging, CORS) and
 * domain routes. Does not start listening — call `.listen()` on the returned
 * instance (see `index.js`).
 * @param {object} [config] Application configuration; defaults to reading from environment.
 * @returns {import('fastify').FastifyInstance} A configured, ready-to-listen Fastify instance.
 */
export function buildApp(config = loadConfig()) {
  const app = Fastify({
    logger: buildLoggerOptions(config),
    disableRequestLogging: true,
    genReqId: () => generateCorrelationId(),
  });

  if (config.logging.logger) {
    registerRequestLogging(app);
  }

  app.decorate('config', config);

  const authService = createAuthService(config.auth.jwtAccessTokenSecret);
  const authenticate = createAuthenticatePreHandler(authService);
  const authorize = createAuthorizePreHandler(authenticate);
  app.decorate('authService', authService);
  app.decorate('authenticate', authenticate);
  app.decorateRequest('principal', null);

  installRouteDeclarationCollector(app);
  app.addHook('preHandler', authorize);

  // Enter ALS for the remainder of the request (Fastify continues inside `done`).
  app.addHook('onRequest', (request, _reply, done) => {
    runWithRequestContext({ correlationId: request.id }, done);
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header(CORRELATION_ID_HEADER, request.id);
    done(null, payload);
  });

  // CORS: allow all origins in non-production environments for local dev convenience.
  if (!config.env.isProduction) {
    void app.register(cors, {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        CORRELATION_ID_HEADER,
        'X-CSRF-Token',
        'Idempotency-Key',
      ],
      exposedHeaders: [CORRELATION_ID_HEADER],
    });
  }

  void app.register(cookie, {
    secret: config.auth.jwtAccessTokenSecret,
  });
  void app.register(fjwt, {
    secret: config.auth.jwtAccessTokenSecret,
    sign: {
      expiresIn: JWT_ACCESS_TOKEN_TTL_SECONDS,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
    },
    verify: {
      allowedIss: JWT_ISSUER,
      allowedAud: JWT_AUDIENCE,
    },
  });
  void app.register(csrf, {
    cookieOpts: {
      signed: false,
      httpOnly: true,
      sameSite: 'strict',
      path: `${API_BASE_PATH}/auth`,
      secure: config.env.isProduction,
    },
    getToken: (request) => {
      const header = request.headers[CSRF_HEADER_NAME];
      return typeof header === 'string' ? header : undefined;
    },
  });

  registerErrorHandler(app);
  registerIdempotency(app);
  // Unversioned infra aliases (same handlers as under API_BASE_PATH).
  void app.register(healthRoutes);
  void app.register(registerRoutes, { prefix: API_BASE_PATH });

  app.addHook('onReady', async () => {
    assertAllRoutesDeclareAccess(app);
  });

  return app;
}
