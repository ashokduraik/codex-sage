import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowsErrorDetails } from './errorCatalog.js';

/** Rotate when the active log file reaches 5 MB. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
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
  const routePath =
    req.routeOptions?.url ??
    req.routerPath ??
    (typeof req.url === 'string' ? req.url.split('?')[0] : undefined);
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
 * @param {string} level Pino level string.
 * @param {{ env: { isProduction: boolean }, logging: { level: string } }} config App config.
 * @returns {object} Base logger option fields (without transport/stream).
 */
function baseLoggerFields(level, config) {
  const includeStack = shouldIncludeStack(config);
  return {
    level,
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
      /** Remove pid; keep hostname so logs are still traceable across machines. */
      bindings: (bindings) => ({
        hostname: bindings['hostname'],
      }),
    },
    /** Emit ISO 8601 wall-clock time instead of epoch milliseconds. */
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };
}

/**
 * Builds the Fastify/Pino logger option from the current application config.
 *
 * - Returns `false` when logging is disabled (e.g. during tests).
 * - `container`: console (stdout) only; `NO_CONSOLE_LOG` is ignored.
 * - `standalone`: rotating file under `backend/logs/api.log` (5 MB, max 10 files),
 *   plus console unless `noConsoleLog` is true.
 *
 * @param {object} config The application configuration.
 * @returns {object | false} A Fastify-compatible logger option.
 */
export function buildLoggerOptions(config) {
  if (!config.logging.logger) {
    return false;
  }
  const level = toPinoLevel(config.logging.level);
  const isContainer = config.env.appRunningPlatform === 'container';
  const wantConsole = isContainer || !config.logging.noConsoleLog;
  const wantFile = !isContainer;
  const base = baseLoggerFields(level, config);

  if (!wantFile) {
    return base;
  }

  // File path without extension: pino-roll appends `.log` via `extension`.
  const fileBase = join(LOG_DIR, LOG_FILE_NAME.replace(/\.log$/i, ''));
  const targets = [];
  if (wantConsole) {
    targets.push({
      target: 'pino/file',
      level,
      options: { destination: 1 },
    });
  }
  targets.push({
    target: 'pino-roll',
    level,
    options: {
      file: fileBase,
      extension: '.log',
      size: '5m',
      mkdir: true,
      limit: { count: LOG_BACKUP_COUNT },
    },
  });
  // Transport runs in a worker — custom formatters/timestamp are not allowed;
  // redact + serializers still apply on the main thread before shipping.
  return {
    level,
    redact: base.redact,
    serializers: base.serializers,
    transport: { targets },
  };
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
    request.log.debug(
      { res: reply, responseTime: reply.elapsedTime },
      'request completed',
    );
    done();
  });
}
