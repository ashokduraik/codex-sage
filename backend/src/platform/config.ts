/**
 * Application runtime configuration read from environment variables.
 * All `process.env` reads are centralised here — no scattered accesses elsewhere.
 */

import { z } from 'zod';

/** Where the API process runs; controls log destinations. */
export type AppRunningPlatform = 'container' | 'standalone';

/** Supported application log levels (env uses `warning`; Pino maps it to `warn`). */
export type AppLogLevel = 'debug' | 'info' | 'warning' | 'error';

/** Environment-derived flags and deployment platform. */
export interface EnvConfig {
  /** Node environment name (`development`, `test`, `production`, …). */
  nodeEnv: string;
  /** True when `nodeEnv === 'production'`. */
  isProduction: boolean;
  /** True when `nodeEnv === 'test'`. */
  isTest: boolean;
  /**
   * Deployment platform: `container` logs to console only; `standalone` writes
   * rotating files under `backend/logs` (plus console unless `noConsoleLog`).
   */
  appRunningPlatform: AppRunningPlatform;
}

/** HTTP bind address. */
export interface ServerConfig {
  /** Hostname the HTTP server should bind to. */
  host: string;
  /** TCP port the HTTP server listens on. */
  port: number;
}

/** Logging behaviour. */
export interface LoggingConfig {
  /** Minimum log level (`debug` | `info` | `warning` | `error`). */
  level: AppLogLevel;
  /** Whether to enable the Fastify/Pino request logger (disabled in tests). */
  logger: boolean;
  /**
   * When true in standalone mode, skip console logging (ignored in container).
   * Set via `NO_CONSOLE_LOG=true`.
   */
  noConsoleLog: boolean;
}

/** MongoDB connection settings from env (driver tunables live in `mongo.ts`). */
export interface MongoConfig {
  /** Replica-set connection string including database name. Never log this value. */
  uri: string;
}

/** Grouped application configuration resolved from the environment. */
export interface AppConfig {
  env: EnvConfig;
  server: ServerConfig;
  logging: LoggingConfig;
  mongo: MongoConfig;
}

const LOG_LEVELS = new Set<string>(['debug', 'info', 'warning', 'error']);

/** Non-empty hostname (after trim). */
const hostSchema = z.string().trim().min(1, { error: 'must be a non-empty hostname' });

/** TCP port 1–65535; default applied before parse when env is absent. */
const portSchema = z.coerce
  .number()
  .int({ error: 'expected integer 1–65535' })
  .min(1, { error: 'expected integer 1–65535' })
  .max(65535, { error: 'expected integer 1–65535' });

/** Required MongoDB URI; never include the received value in error output. */
const mongoUriSchema = z
  .string()
  .trim()
  .min(1, { error: 'required MongoDB connection string (no default)' });

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
  const result = portSchema.safeParse(raw ?? '3000');
  if (!result.success) {
    throw new Error('API_PORT: expected integer 1–65535');
  }
  return result.data;
}

/**
 * Appends a field validation failure using a fixed message (never the raw value).
 * @param errors - Accumulator of `VARIABLE: message` lines.
 * @param variable - Env variable name.
 * @param result - Zod safe-parse result.
 */
function collectFieldError(
  errors: string[],
  variable: string,
  result: z.ZodSafeParseResult<unknown>,
): void {
  if (result.success) {
    return;
  }
  const message = result.error.issues[0]?.message ?? 'invalid';
  errors.push(`${variable}: ${message}`);
}

/**
 * Builds an {@link AppConfig} by reading environment variables.
 * Collects every validation error before throwing so operators see the full list.
 * Thrown messages name variables and expected formats but never include secret values.
 * @param env - Environment variable map; defaults to `process.env`.
 * @returns Populated application configuration object.
 * @throws {Error} When one or more required values are missing or invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];

  const hostResult = hostSchema.safeParse(env.API_HOST ?? '0.0.0.0');
  collectFieldError(errors, 'API_HOST', hostResult);

  const portResult = portSchema.safeParse(env.API_PORT ?? '3000');
  collectFieldError(errors, 'API_PORT', portResult);

  const mongoResult = mongoUriSchema.safeParse(env.MONGODB_URI ?? '');
  collectFieldError(errors, 'MONGODB_URI', mongoResult);

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.join('\n')}`);
  }

  const nodeEnv = env.NODE_ENV ?? 'development';

  return {
    env: {
      nodeEnv,
      isProduction: nodeEnv === 'production',
      isTest: nodeEnv === 'test',
      appRunningPlatform: parseAppRunningPlatform(env.APP_RUNNING_PLATFORM),
    },
    server: {
      host: hostResult.data as string,
      port: portResult.data as number,
    },
    logging: {
      level: parseLogLevel(env.LOG_LEVEL),
      logger: nodeEnv !== 'test',
      noConsoleLog: env.NO_CONSOLE_LOG === 'true',
    },
    mongo: {
      uri: mongoResult.data as string,
    },
  };
}
