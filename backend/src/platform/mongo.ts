/**
 * Mongoose connection lifecycle for the API and worker processes.
 * The only module that talks to Mongoose's connection API.
 */

import mongoose from 'mongoose';
import type { AppConfig } from './config';

/** Connection pool upper bound. */
export const MONGODB_MAX_POOL_SIZE = 20;

/** Connection pool lower bound. */
export const MONGODB_MIN_POOL_SIZE = 0;

/** Wait for a primary before failing the initial connect / selection. */
export const MONGODB_SERVER_SELECTION_TIMEOUT_MS = 10_000;

/** Socket inactivity timeout. */
export const MONGODB_SOCKET_TIMEOUT_MS = 45_000;

/** Stable code returned to readiness when ping fails (never driver text). */
export const MONGO_UNAVAILABLE_CODE = 'MONGO_UNAVAILABLE' as const;

/** High-level connection state for readiness and diagnostics. */
export type MongoConnectionState =
  | 'disconnected'
  | 'connected'
  | 'connecting'
  | 'disconnecting';

/** Result of an admin ping health check. */
export interface MongoHealthResult {
  ok: boolean;
  latencyMs: number;
  error?: { code: typeof MONGO_UNAVAILABLE_CODE };
}

/** Logger seam used by connect/disconnect so tests can assert without Pino. */
export interface MongoLog {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

const defaultLog: MongoLog = {
  info: (obj, msg) => console.info(JSON.stringify({ level: 'info', msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

let listenersAttached = false;

/**
 * Extracts a host-less descriptor safe for logs (db name + replicaSet only).
 * @param uri - Full MongoDB connection string (never logged).
 * @returns Redacted summary fields.
 */
export function describeMongoUri(uri: string): { database: string; replicaSet?: string } {
  try {
    const parsed = new URL(uri);
    const database = parsed.pathname.replace(/^\//, '') || '(default)';
    const replicaSet = parsed.searchParams.get('replicaSet') ?? undefined;
    return replicaSet ? { database, replicaSet } : { database };
  } catch {
    return { database: '(unparseable)' };
  }
}

/**
 * Maps Mongoose `readyState` integers to named connection states.
 * @param readyState - Mongoose connection readyState (0–3, or other).
 * @returns Named connection state; unknown values map to `disconnected`.
 */
export function mapReadyState(readyState: number): MongoConnectionState {
  switch (readyState) {
    case 0:
      return 'disconnected';
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 3:
      return 'disconnecting';
    default:
      return 'disconnected';
  }
}

/**
 * Returns the current Mongoose connection state.
 * @returns Named connection state.
 */
export function getMongoConnectionState(): MongoConnectionState {
  return mapReadyState(mongoose.connection.readyState);
}

/**
 * Attaches disconnect/reconnect log listeners once per process.
 * @param log - Logger seam.
 */
function attachConnectionListeners(log: MongoLog): void {
  if (listenersAttached) {
    return;
  }
  listenersAttached = true;

  mongoose.connection.on('disconnected', () => {
    log.warn({}, 'mongo disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    log.info({}, 'mongo reconnected');
  });
  mongoose.connection.on('error', (err: Error) => {
    log.error({ errName: err.name }, 'mongo connection error');
  });
}

/**
 * Opens the Mongoose connection and awaits the first successful connect.
 * Fails fast: callers should exit non-zero if this rejects.
 * @param config - Application config containing `mongo.uri`.
 * @param log - Optional logger (defaults to structured console).
 */
export async function connectMongo(
  config: AppConfig,
  log: MongoLog = defaultLog,
): Promise<void> {
  const summary = describeMongoUri(config.mongo.uri);
  attachConnectionListeners(log);

  mongoose.set('bufferCommands', false);
  mongoose.set('autoIndex', !config.env.isProduction);

  try {
    await mongoose.connect(config.mongo.uri, {
      maxPoolSize: MONGODB_MAX_POOL_SIZE,
      minPoolSize: MONGODB_MIN_POOL_SIZE,
      serverSelectionTimeoutMS: MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      socketTimeoutMS: MONGODB_SOCKET_TIMEOUT_MS,
    });
    log.info(
      {
        ...summary,
        poolSize: MONGODB_MAX_POOL_SIZE,
        state: getMongoConnectionState(),
      },
      'mongo connected',
    );
  } catch (err) {
    const errName = err instanceof Error ? err.name : 'Error';
    log.error({ ...summary, errName }, 'mongo connect failed');
    throw err;
  }
}

/**
 * Closes the Mongoose connection. Idempotent — safe to call twice.
 */
export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) {
    return;
  }
  await mongoose.disconnect();
}

/**
 * Runs an admin `ping` and reports latency without exposing driver messages.
 * @returns Health result with a code-only error when the ping fails.
 */
export async function checkMongoHealth(): Promise<MongoHealthResult> {
  const started = Date.now();
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: { code: MONGO_UNAVAILABLE_CODE },
      };
    }
    await mongoose.connection.db.admin().ping();
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: { code: MONGO_UNAVAILABLE_CODE },
    };
  }
}

/**
 * Resets listener attachment guard for unit tests.
 */
export function resetMongoListenersForTests(): void {
  listenersAttached = false;
}
