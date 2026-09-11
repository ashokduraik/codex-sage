/**
 * Application runtime configuration read from environment variables.
 * All `process.env` reads are centralised here — no scattered accesses elsewhere.
 */

/** Where the API process runs; controls log destinations. */
export type AppRunningPlatform = 'container' | 'standalone';

/** Supported application log levels (env uses `warning`; Pino maps it to `warn`). */
export type AppLogLevel = 'debug' | 'info' | 'warning' | 'error';

export interface AppConfig {
  /** Hostname the HTTP server should bind to. */
  host: string;
  /** TCP port the HTTP server listens on. */
  port: number;
  /** Node environment name; drives env-specific behaviour. */
  nodeEnv: string;
  /** Whether to enable the Fastify/Pino request logger (disabled in tests). */
  logger: boolean;
  /**
   * Deployment platform: `container` logs to console only; `standalone` writes
   * rotating files under `backend/logs` (plus console unless `noConsoleLog`).
   */
  appRunningPlatform: AppRunningPlatform;
  /** Minimum log level (`debug` | `info` | `warning` | `error`). */
  logLevel: AppLogLevel;
  /**
   * When true in standalone mode, skip console logging (ignored in container).
   * Set via `NO_CONSOLE_LOG=true`.
   */
  noConsoleLog: boolean;
}

const LOG_LEVELS = new Set<string>(['debug', 'info', 'warning', 'error']);

/**
 * Parses `APP_RUNNING_PLATFORM` into a known platform value.
 * Unknown values fall back to standalone (the default for local runs).
 * @param raw - Raw env value.
 * @returns `container` or `standalone`.
 */
export function parseAppRunningPlatform(raw: string | undefined): AppRunningPlatform {
  const value = (raw ?? 'standalone').trim().toLowerCase();
  return value === 'container' ? 'container' : 'standalone';
}

/**
 * Parses `LOG_LEVEL` into a supported level; unknown values fall back to `info`.
 * @param raw - Raw env value.
 * @returns One of debug/info/warning/error.
 */
export function parseLogLevel(raw: string | undefined): AppLogLevel {
  const value = (raw ?? 'info').trim().toLowerCase();
  return LOG_LEVELS.has(value) ? (value as AppLogLevel) : 'info';
}

/**
 * Parses and validates `API_PORT`.
 * @param raw - Raw env value.
 * @returns A TCP port in the range 1–65535.
 * @throws {Error} When the value is not a valid port number.
 */
export function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid API_PORT: ${raw ?? '(empty)'} (expected integer 1–65535)`);
  }
  return port;
}

/**
 * Builds an {@link AppConfig} by reading environment variables.
 * @param env - Environment variable map; defaults to `process.env`.
 * @returns Populated application configuration object.
 * @throws {Error} When required values are invalid (e.g. `API_PORT`).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = (env.API_HOST ?? '0.0.0.0').trim();
  if (!host) {
    throw new Error('Invalid API_HOST: must be a non-empty hostname');
  }

  return {
    host,
    port: parsePort(env.API_PORT),
    nodeEnv: env.NODE_ENV ?? 'development',
    logger: env.NODE_ENV !== 'test',
    appRunningPlatform: parseAppRunningPlatform(env.APP_RUNNING_PLATFORM),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    noConsoleLog: env.NO_CONSOLE_LOG === 'true',
  };
}
