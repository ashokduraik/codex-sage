/**
 * Builds and configures the Fastify application instance.
 * Registers platform concerns (error handling, structured logging, CORS) and
 * domain routes. Does not start listening — call `.listen()` on the returned
 * instance (see `index.js`).
 */
import fjwt from '@fastify/jwt';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import { registerRoutes } from './route.js';
import csrf from '@fastify/csrf-protection';
import Fastify, { LogController } from 'fastify';
import { loadConfig } from '../platform/config.js';
import { registerErrorHandler } from '../platform/errors.js';
import { getHealthHttp, getReadinessHttp } from './health.routes.js';
import { configureProjectAclCache } from '../modules/masters/index.js';
import { registerIdempotency } from '../platform/idempotency/index.js';
import { registerStaticAssets, resolveProductionDistRoot, tryServeSpaIndex } from './static-spa.js';
import { buildLoggerOptions, createRequestChildLogger, registerRequestLogging } from '../platform/logger.js';
import { MULTIPART_MAX_FILES, UPLOAD_MAX_ARCHIVE_BYTES, consumeSourceArchivePreHandler } from '../modules/knowledge/index.js';
import {
  JWT_ISSUER,
  JWT_AUDIENCE,
  createAuthService,
  CSRF_SECRET_COOKIE_NAME,
  createAuthorizePreHandler,
  assertAllRoutesDeclareAccess,
  createAuthenticatePreHandler,
  JWT_ACCESS_TOKEN_TTL_SECONDS,
  JWT_REFRESH_TOKEN_TTL_SECONDS,
  installRouteDeclarationCollector,
} from '../modules/access/index.js';

/** Versioned API route prefix — product contract, not an env var. */
export const API_BASE_PATH = '/api/v1';
/** Response header carrying the request correlation reference. */
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';
/** Prefix of the generated correlation reference (backend §105). */
export const CORRELATION_ID_PREFIX = 'REQ';

/**
 * Generates a server-side correlation id: `REQ-` + 32 hex (UUID without dashes).
 * Client-supplied ids are never honoured.
 * @returns {string}
 */
export function generateCorrelationId() {
  return `${CORRELATION_ID_PREFIX}-${randomUUID().replace(/-/g, '')}`;
}

/** CSRF header the browser must echo on refresh/logout. */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Builds and configures the Fastify application instance.
 * Registers platform concerns (error handling, structured logging, CORS) and
 * domain routes. Does not start listening — call `.listen()` on the returned
 * instance (see `index.js`).
 * @param {object} [config] Application configuration; defaults to reading from environment.
 * @param {{ loggerInstance?: import('pino').Logger | false }} [options] Optional pre-built
 *   Pino instance from {@link createAppLogger} (standalone file + console).
 * @returns {import('fastify').FastifyInstance} A configured, ready-to-listen Fastify instance.
 */
export function buildApp(config = loadConfig(), options = {}) {
  configureProjectAclCache(config.env);

  const { loggerOption, loggingEnabled } = resolveFastifyLoggerConfig(config, options);

  // Suppress Fastify's default info-level request logs; registerRequestLogging emits debug instead.
  const app = Fastify({
    ...loggerOption,
    genReqId: () => generateCorrelationId(),
    logController: new LogController({ disableRequestLogging: true }),
    ...(loggingEnabled ? { childLoggerFactory: createRequestChildLogger } : {}),
  });

  if (loggingEnabled) {
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
      allowedHeaders: ['Authorization', 'Content-Type', CORRELATION_ID_HEADER, 'X-CSRF-Token', 'Idempotency-Key'],
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
    // Keep the httpOnly secret aligned with the refresh cookie TTL (not a session cookie).
    cookieKey: CSRF_SECRET_COOKIE_NAME,
    cookieOpts: {
      signed: false,
      httpOnly: true,
      sameSite: 'strict',
      path: `${API_BASE_PATH}/auth`,
      secure: config.env.isProduction,
      maxAge: JWT_REFRESH_TOKEN_TTL_SECONDS,
    },
    getToken: (request) => {
      const header = request.headers[CSRF_HEADER_NAME];
      return typeof header === 'string' ? header : undefined;
    },
  });

  const frontendDistRoot = resolveProductionDistRoot({
    isProduction: config.env.isProduction,
    frontendDistRoot: config.frontendDistRoot,
  });

  registerErrorHandler(app, {
    trySpaFallback: frontendDistRoot ? tryServeSpaIndex : undefined,
  });

  void app.register(multipart, {
    limits: {
      fileSize: UPLOAD_MAX_ARCHIVE_BYTES,
      files: MULTIPART_MAX_FILES,
    },
  });
  app.decorateRequest('sourceUpload', null);
  // Must run before Phase 12 idempotency so request.body carries archiveSha256.
  app.addHook('preHandler', consumeSourceArchivePreHandler);
  registerIdempotency(app);
  // Unversioned infra aliases (same handlers as under API_BASE_PATH).
  app.get('/health', { config: { routeAccess: 'public' } }, getHealthHttp);
  app.get('/readiness', { config: { routeAccess: 'public' } }, getReadinessHttp);
  void app.register(registerRoutes, { prefix: API_BASE_PATH });

  // Production: serve hashed assets; SPA fallback is wired via the not-found handler above.
  registerStaticAssets(app, frontendDistRoot);

  app.addHook('onReady', async () => {
    assertAllRoutesDeclareAccess(app);
  });

  return app;

  /**
   * Resolves Fastify logger options from config and an optional pre-built instance.
   * @param {object} config Application configuration.
   * @param {{ loggerInstance?: import('pino').Logger | false }} [options]
   * @returns {{
   *   loggerOption: { logger: object | false } | { loggerInstance: import('pino').Logger },
   *   loggingEnabled: boolean,
   * }}
   */
  function resolveFastifyLoggerConfig(config, options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'loggerInstance')) {
      if (options.loggerInstance === false || options.loggerInstance == null) {
        return { loggerOption: { logger: false }, loggingEnabled: false };
      }
      return {
        loggerOption: { loggerInstance: options.loggerInstance },
        loggingEnabled: true,
      };
    }
    const logger = buildLoggerOptions(config);
    return {
      loggerOption: { logger },
      loggingEnabled: logger !== false,
    };
  }
}
