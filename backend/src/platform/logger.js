import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import createRollStream from 'pino-roll';
import { allowsErrorDetails } from './errorCatalog.js';

/**
 * Rotated backups kept in addition to the active file.
 * Active + backups ≤ 10 files on disk.
 */
export const LOG_BACKUP_COUNT = 9;
/** Active log file name under `backend/logs`. */
export const LOG_FILE_NAME = 'api.log';
/** Absolute path to `backend/` (works from `src/` and compiled `dist/`). */
const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Directory for standalone rotating log files. */
export const LOG_DIR = join(API_ROOT, 'logs');

/** Pino path redaction — safety net for secrets that slip into log objects. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'credentials',
  'secret',
  'mongodbUri',
  'connectionString',
  'privateKey',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.credentials',
  '*.secret',
  '*.mongodbUri',
  '*.connectionString',
  '*.privateKey',
];

/**
 * Maps env log levels to Pino level names (`warning` → `warn`).
 * @param {string} level Application log level from config.
 * @returns {string} Pino-compatible level string.
 */
export function toPinoLevel(level) {
  return level === 'warning' ? 'warn' : level;
}

/**
 * Safe request serializer: method, route path, reqId, remoteAddress only.
 * Drops query string (may carry search terms) and never dumps headers/body.
 *
 * @param {object} req Incoming request-like object.
 * @returns {{ method?: string, path?: string, reqId?: string, remoteAddress?: string }}
 */
export function serializeRequest(req) {
  if (!req || typeof req !== 'object') {
    return {};
  }
  const routePath = req.routeOptions?.url ?? req.routerPath ?? (typeof req.url === 'string' ? req.url.split('?')[0] : undefined);
  return {
    method: req.method,
    path: routePath,
    reqId: req.id,
    remoteAddress: req.socket?.remoteAddress ?? req.ip,
  };
}

/**
 * Safe error serializer. Stack inclusion is controlled by `includeStack`.
 * Drops `details` unless the catalog marks that code's details non-sensitive.
 *
 * @param {Error & { code?: string, details?: unknown, statusCode?: number }} err
 * @param {{ includeStack?: boolean }} [options]
 * @returns {object}
 */
export function serializeError(err, options = {}) {
  if (!err || typeof err !== 'object') {
    return { message: String(err) };
  }
  const includeStack = options.includeStack !== false;
  /** @type {Record<string, unknown>} */
  const out = {
    type: err.name,
    message: err.message,
  };
  if (includeStack && err.stack) {
    out.stack = err.stack;
  }
  if (typeof err.code === 'string') {
    out.code = err.code;
  }
  if (typeof err.statusCode === 'number') {
    out.statusCode = err.statusCode;
  }
  if (typeof err.code === 'string' && allowsErrorDetails(err.code) && err.details !== undefined) {
    out.details = err.details;
  }
  return out;
}

/**
 * Whether stack traces should appear for a given log level label under this config.
 * Development / debug: always. Production: only at error.
 *
 * @param {{ env: { isProduction: boolean }, logging: { level: string } }} config
 * @param {string} [logLevelLabel] Pino level label for this line.
 * @returns {boolean}
 */
export function shouldIncludeStack(config, logLevelLabel = 'error') {
  if (!config.env.isProduction || config.logging.level === 'debug') {
    return true;
  }
  return logLevelLabel === 'error';
}

/**
 * Shared Pino formatters, serializers, redact, and timestamp.
 * Main-thread encoding (no worker transport) so level labels and ISO time apply
 * to console and rotating file alike.
 *
 * @param {string} level Pino level string.
 * @param {{ env: { isProduction: boolean }, logging: { level: string } }} config App config.
 * @returns {object} Base logger option fields (without stream).
 */
function baseLoggerFields(level, config) {
  const includeStack = shouldIncludeStack(config);
  return {
    level,
    // Drop default pid/hostname — not useful in local or single-product deploys.
    base: undefined,
    redact: {
      paths: LOG_REDACT_PATHS,
      censor: '[redacted]',
    },
    serializers: {
      req: serializeRequest,
      err: (err) => serializeError(err, { includeStack }),
    },
    formatters: {
      /** Emit the level name ("info") instead of the numeric Pino severity code (30). */
      level: (label) => ({ level: label }),
      /** Ensure pid/hostname stay absent even if a caller reintroduces base bindings. */
      bindings: () => ({}),
    },
    /** Emit ISO 8601 wall-clock time instead of epoch milliseconds. */
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };
}

/**
 * Builds sync Fastify/Pino logger options (stdout / default destination only).
 * Rotating file output requires {@link createAppLogger} — worker transports cannot
 * carry custom level/time formatters.
 *
 * - Returns `false` when logging is disabled (e.g. during tests).
 * - Suitable for tests and as a fallback when no pre-built logger instance is passed.
 *
 * @param {object} config The application configuration.
 * @returns {object | false} A Fastify-compatible logger option.
 */
export function buildLoggerOptions(config) {
  if (!config.logging.logger) {
    return false;
  }
  return baseLoggerFields(toPinoLevel(config.logging.level), config);
}

/**
 * Creates a ready-to-use Pino logger for the API process.
 *
 * - Returns `false` when logging is disabled.
 * - `container`: stdout only (`NO_CONSOLE_LOG` ignored).
 * - `standalone`: rotating file under `backend/logs/api.log` (5 MB, max 10 files),
 *   plus stdout unless `noConsoleLog` is true.
 *
 * Uses main-thread streams (not worker transport) so level labels and ISO timestamps
 * appear on every line.
 *
 * @param {object} config The application configuration.
 * @returns {Promise<import('pino').Logger | false>}
 */
export async function createAppLogger(config) {
  if (!config.logging.logger) {
    return false;
  }
  const level = toPinoLevel(config.logging.level);
  const base = baseLoggerFields(level, config);
  const isContainer = config.env.appRunningPlatform === 'container';
  const wantConsole = isContainer || !config.logging.noConsoleLog;
  const wantFile = !isContainer;

  if (!wantFile) {
    return pino(base);
  }

  const fileBase = join(LOG_DIR, LOG_FILE_NAME.replace(/\.log$/i, ''));
  const fileStream = await createRollStream({
    file: fileBase,
    extension: '.log',
    size: '5m',
    mkdir: true,
    limit: { count: LOG_BACKUP_COUNT },
  });

  /** @type {import('pino').StreamEntry[]} */
  const streams = [];
  if (wantConsole) {
    streams.push({ level, stream: process.stdout });
  }
  streams.push({ level, stream: fileStream });

  if (streams.length === 1) {
    return pino(base, streams[0].stream);
  }
  return pino(base, pino.multistream(streams));
}

/**
 * Fastify child-logger factory: bind reqId (from Fastify), method, and path-only url.
 *
 * @param {import('pino').Logger} logger Parent logger.
 * @param {Record<string, unknown>} bindings Default Fastify bindings (includes reqId).
 * @param {object} opts Child logger options from Fastify.
 * @param {{ method?: string, url?: string }} rawReq Node IncomingMessage.
 * @returns {import('pino').Logger}
 */
export function createRequestChildLogger(logger, bindings, opts, rawReq) {
  const urlPath = typeof rawReq?.url === 'string' ? rawReq.url.split('?')[0] : undefined;
  return logger.child(
    {
      ...bindings,
      method: rawReq?.method,
      url: urlPath,
    },
    opts,
  );
}

/**
 * Registers per-request access logs at `debug` (Fastify defaults to `info`).
 *
 * @param {import('fastify').FastifyInstance} app Fastify instance with logging enabled.
 */
export function registerRequestLogging(app) {
  app.addHook('onRequest', (request, _reply, done) => {
    request.log.debug({ req: request }, 'incoming request');
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    request.log.debug({ res: reply, responseTime: reply.elapsedTime }, 'request completed');
    done();
  });
}
