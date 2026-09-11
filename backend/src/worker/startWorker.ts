/**
 * Worker boot sequence — separate PID/event-loop process from the API.
 * Phase 01 idles after connecting to Mongo; Phase 21 replaces the heartbeat
 * with the job claim loop.
 */

import { hostname } from 'node:os';
import { loadConfig, type AppConfig } from '../platform/config';
import { connectMongo, disconnectMongo, type MongoLog } from '../platform/mongo';
import { registerProcessHandlers } from '../platform/processHandlers';
import {
  attachShutdownSignals,
  registerShutdownHook,
  type ShutdownDeps,
} from '../platform/shutdown';

/** Idle heartbeat interval until Phase 21 wires the claim loop. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

/** Injectable dependencies for {@link startWorker} (tests supply fakes). */
export interface WorkerDeps {
  loadConfig?: () => AppConfig;
  connectMongo?: (config: AppConfig, log?: MongoLog) => Promise<void>;
  disconnectMongo?: () => Promise<void>;
  registerProcessHandlers?: typeof registerProcessHandlers;
  registerShutdownHook?: typeof registerShutdownHook;
  attachShutdownSignals?: typeof attachShutdownSignals;
  log?: MongoLog & ShutdownDeps['log'];
  hostname?: () => string;
  pid?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  exit?: (code: number) => never;
}

/**
 * Boots the worker: process handlers → config → Mongo → heartbeat → shutdown.
 * @param deps - Optional seams for unit tests.
 * @returns Handle that clears the heartbeat interval (for tests).
 */
export async function startWorker(deps: WorkerDeps = {}): Promise<{
  workerId: string;
  stopHeartbeat: () => void;
}> {
  const log: MongoLog & ShutdownDeps['log'] = deps.log ?? {
    info: (obj, msg) => console.info(JSON.stringify({ level: 'info', msg, ...obj })),
    warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
    error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
  };

  const registerHandlers = deps.registerProcessHandlers ?? registerProcessHandlers;
  registerHandlers({
    logError: (message, context) => {
      log.error({ ...(context ?? {}) }, message);
    },
    exit: deps.exit,
  });

  const config = (deps.loadConfig ?? loadConfig)();

  try {
    await (deps.connectMongo ?? connectMongo)(config, log);
  } catch {
    (deps.exit ?? ((code: number) => process.exit(code) as never))(1);
    throw new Error('worker mongo connect failed');
  }

  const workerId = `${(deps.hostname ?? hostname)()}:${deps.pid ?? process.pid}`;
  log.info({ workerId }, 'worker started');

  const schedule = deps.setInterval ?? setInterval;
  const clear = deps.clearInterval ?? clearInterval;
  const heartbeat = schedule(() => {
    log.info({ workerId }, 'worker heartbeat');
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  // Allow the process to exit naturally in tests / idle shutdown.
  if (typeof heartbeat === 'object' && 'unref' in heartbeat) {
    heartbeat.unref();
  }

  const registerHook = deps.registerShutdownHook ?? registerShutdownHook;
  registerHook('clear-heartbeat', async () => {
    clear(heartbeat);
  });
  registerHook('disconnect-mongo', async () => {
    await (deps.disconnectMongo ?? disconnectMongo)();
  });

  (deps.attachShutdownSignals ?? attachShutdownSignals)({
    log,
    exit: deps.exit,
  });

  return {
    workerId,
    stopHeartbeat: () => clear(heartbeat),
  };
}
