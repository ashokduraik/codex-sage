/**
 * Mongoose connection lifecycle for the API and worker processes.
 * The only module that talks to Mongoose's connection API.
 */
import mongoose from 'mongoose';
import { caughtErrorFields } from './errors.js';
import { MONGO_UNAVAILABLE_CODE } from './errorCatalog.js';

/** Connection pool upper bound. */
export const MONGODB_MAX_POOL_SIZE = 20;
/** Connection pool lower bound. */
export const MONGODB_MIN_POOL_SIZE = 0;
/** Wait for a primary before failing the initial connect / selection. */
export const MONGODB_SERVER_SELECTION_TIMEOUT_MS = 10_000;
/** Socket inactivity timeout. */
export const MONGODB_SOCKET_TIMEOUT_MS = 45_000;
/** Re-export catalog code so readiness consumers keep a stable import path. */
export { MONGO_UNAVAILABLE_CODE };
const defaultLog = {
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
export function describeMongoUri(uri) {
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
export function mapReadyState(readyState) {
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
 * Opens the Mongoose connection and awaits the first successful connect.
 * Fails fast: callers should exit non-zero if this rejects.
 * @param config - Application config containing `mongo.uri`.
 * @param log - Optional logger (defaults to structured console).
 */
export async function connectMongo(config, log = defaultLog) {
  const summary = describeMongoUri(config.mongo.uri);
  attachConnectionListeners(log);
  mongoose.set('bufferCommands', false);
  // Indexes are declared on schemas and synced explicitly in development / tests.
  mongoose.set('autoIndex', false);
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
        state: mapReadyState(mongoose.connection.readyState),
      },
      'mongo connected',
    );
  } catch (err) {
    log.error({ ...summary, ...caughtErrorFields(err) }, 'mongo connect failed');
    throw err;
  }

  /**
   * Attaches disconnect/reconnect log listeners once per process.
   * @param log - Logger seam.
   */
  function attachConnectionListeners(log) {
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
    mongoose.connection.on('error', (err) => {
      log.error(caughtErrorFields(err), 'mongo connection error');
    });
  }
}
/**
 * Closes the Mongoose connection. Idempotent — safe to call twice.
 */
export async function disconnectMongo() {
  if (mongoose.connection.readyState === 0) {
    return;
  }
  await mongoose.disconnect();
}
/**
 * Runs an admin `ping` and reports latency without exposing driver messages.
 * @returns Health result with a code-only error when the ping fails.
 */
export async function checkMongoHealth() {
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
export function resetMongoListenersForTests() {
  listenersAttached = false;
}
