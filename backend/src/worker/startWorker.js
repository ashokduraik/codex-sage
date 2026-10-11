/**
 * Worker boot sequence — separate PID/event-loop process from the API.
 * Phase 21: claim loop, heartbeat, lease sweeper, graceful drain.
 */
import { hostname } from 'node:os';
import { loadConfig } from '../platform/config.js';
import { connectMongo, disconnectMongo } from '../platform/mongo.js';
import { syncSchemaIndexes } from '../platform/data/index.js';
import { JOB_MODELS, NOTIFICATION_MODELS, PROJECT_ACTIVITY_MODELS } from '../modules/masters/index.js';
import { retentionHandlerRegistration, enqueueDueRetentionJobs, RETENTION_SCHEDULER_TICK_MS } from '../modules/masters/index.js';
import { SOURCE_MODELS } from '../modules/knowledge/index.js';
import { DOCUMENT_MODELS } from '../modules/knowledge/index.js';
import { PROJECT_MODELS } from '../modules/masters/index.js';
import { KNOWLEDGE_MODELS } from '../modules/knowledge/index.js';
import { REPOSITORY_MODELS } from '../modules/knowledge/index.js';
import { CONVERSATION_MODELS } from '../modules/conversation/index.js';
import { AUDIT_MODELS } from '../modules/access/index.js';
import { caughtErrorFields } from '../platform/errors.js';
import { attachShutdownSignals, registerProcessHandlers, registerShutdownHook } from '../platform/shutdown.js';
import { clearJobHandlersForTests, registerJobHandler } from './handlerRegistry.js';
import { workerSmokeHandlerRegistration } from './handlers/workerSmokeHandler.js';
import { ingestHandlerRegistration, reingestHandlerRegistration } from '../modules/knowledge/index.js';
import { enqueueDueRepositorySyncs, repoSyncHandlerRegistration, REPO_SYNC_SCHEDULER_TICK_MS } from '../modules/knowledge/index.js';
import { ProjectJobLock } from '../models/projectJobLock.model.js';
import { buildWorkerId, startWorkerRuntime } from './workerRuntime.js';
import { WORKER_HEARTBEAT_INTERVAL_MS, assertWorkerLeaseTimingSafe } from './worker.constants.js';

export { WORKER_HEARTBEAT_INTERVAL_MS };

/** Models whose indexes the worker syncs in non-production. */
export const WORKER_MODELS = Object.freeze([
  ...JOB_MODELS,
  ...NOTIFICATION_MODELS,
  ...PROJECT_ACTIVITY_MODELS,
  ...SOURCE_MODELS,
  ...DOCUMENT_MODELS,
  ...PROJECT_MODELS,
  ...KNOWLEDGE_MODELS,
  ...REPOSITORY_MODELS,
  ...CONVERSATION_MODELS,
  ...AUDIT_MODELS,
  ProjectJobLock,
]);

/**
 * Boots the worker: process handlers → config → Mongo → handlers → runtime → shutdown.
 * @param {object} [deps] Optional seams for unit tests.
 * @returns {Promise<{
 *   workerId: string,
 *   stopRuntime: () => Promise<void>,
 *   runtime: ReturnType<typeof startWorkerRuntime>,
 * }>}
 */
export async function startWorker(deps = {}) {
  assertWorkerLeaseTimingSafe();

  const log = deps.log ?? {
    debug: (obj, msg) => console.debug(JSON.stringify({ level: 'debug', msg, ...obj })),
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
  } catch (err) {
    log.error?.(caughtErrorFields(err), 'worker mongo connect failed');
    (deps.exit ?? ((code) => process.exit(code)))(1);
    throw new Error('worker mongo connect failed', { cause: err });
  }

  if (!config.env?.isProduction) {
    try {
      await (deps.syncSchemaIndexes ?? syncSchemaIndexes)(WORKER_MODELS);
    } catch (err) {
      log.error(caughtErrorFields(err), 'worker schema index sync failed');
      (deps.exit ?? ((code) => process.exit(code)))(1);
      throw new Error('worker index sync failed', { cause: err });
    }
  }

  if (deps.clearHandlersForTests) {
    clearJobHandlersForTests();
  }
  const register = deps.registerJobHandler ?? registerJobHandler;
  if (!deps.skipDefaultHandlers) {
    register(workerSmokeHandlerRegistration);
    register(ingestHandlerRegistration);
    register(reingestHandlerRegistration);
    register(repoSyncHandlerRegistration);
    register(retentionHandlerRegistration);
  }
  if (typeof deps.registerExtraHandlers === 'function') {
    deps.registerExtraHandlers(register);
  }

  const workerId =
    deps.workerId ??
    buildWorkerId({
      hostname: (deps.hostname ?? hostname)(),
      pid: deps.pid ?? process.pid,
      bootSuffix: deps.bootSuffix,
    });

  log.info({ workerId }, 'worker started');

  const startRuntime = deps.startWorkerRuntime ?? startWorkerRuntime;
  const runtime = startRuntime({
    workerId,
    log,
    setInterval: deps.setInterval,
    clearInterval: deps.clearInterval,
    maxConcurrentJobs: deps.maxConcurrentJobs,
    pollIntervalMs: deps.pollIntervalMs,
    heartbeatIntervalMs: deps.heartbeatIntervalMs,
    sweepIntervalMs: deps.sweepIntervalMs,
    drainTimeoutMs: deps.drainTimeoutMs,
  });

  const registerHook = deps.registerShutdownHook ?? registerShutdownHook;
  const enableScheduler = deps.enableRepoSyncScheduler ?? deps.startWorkerRuntime == null;
  if (enableScheduler) {
    const schedule = deps.setInterval ?? setInterval;
    const clear = deps.clearInterval ?? clearInterval;
    const enqueueDue = deps.enqueueDueRepositorySyncs ?? enqueueDueRepositorySyncs;
    const enqueueRetention = deps.enqueueDueRetentionJobs ?? enqueueDueRetentionJobs;
    const repoTick = () => {
      enqueueDue({ log }).catch((err) => {
        log.error?.(caughtErrorFields(err), 'repo_sync scheduler tick failed');
      });
    };
    const retentionTick = () => {
      enqueueRetention({ log }).catch((err) => {
        log.error?.(caughtErrorFields(err), 'retention scheduler tick failed');
      });
    };
    repoTick();
    retentionTick();
    const timer = schedule(repoTick, REPO_SYNC_SCHEDULER_TICK_MS);
    const retentionTimer = schedule(retentionTick, RETENTION_SCHEDULER_TICK_MS);
    registerHook('stop-repo-sync-scheduler', async () => {
      clear(timer);
      clear(retentionTimer);
    });
  }
  registerHook('stop-worker-runtime', async () => {
    await runtime.stop();
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
    runtime,
    stopRuntime: () => runtime.stop(),
  };
}
