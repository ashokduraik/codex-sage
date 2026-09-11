import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
/**
 * Maps env log levels to Pino level names (`warning` → `warn`).
 * @param level - Application log level from config.
 * @returns Pino-compatible level string.
 */
export function toPinoLevel(level) {
    return level === 'warning' ? 'warn' : level;
}
/**
 * Shared Pino formatters and timestamp used for both console and file sinks.
 * @param level - Pino level string.
 * @returns Base logger option fields (without transport/stream).
 */
function baseLoggerFields(level) {
    return {
        level,
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
 * @param config - The application configuration.
 * @returns A Fastify-compatible logger option.
 */
export function buildLoggerOptions(config) {
    if (!config.logging.logger)
        return false;
    const level = toPinoLevel(config.logging.level);
    const isContainer = config.env.appRunningPlatform === 'container';
    const wantConsole = isContainer || !config.logging.noConsoleLog;
    const wantFile = !isContainer;
    if (!wantFile) {
        return baseLoggerFields(level);
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
    // Transport runs in a worker — custom formatters/timestamp are not allowed.
    return {
        level,
        transport: { targets },
    };
}
/**
 * Registers per-request access logs at `debug` (Fastify defaults to `info`).
 *
 * @param app - Fastify instance with logging enabled.
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
