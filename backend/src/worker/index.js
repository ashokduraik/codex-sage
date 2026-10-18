/**
 * Worker process entrypoint — loads env, boots Mongo, registers jobs, starts schedule.
 */
import 'dotenv/config';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../platform/config.js';
import { AUDIT_MODELS } from '../modules/access/index.js';
import { caughtErrorFields } from '../platform/errors.js';
import { PROJECT_MODELS } from '../modules/masters/index.js';
import { syncSchemaIndexes } from '../platform/data/index.js';
import { ProjectJobLock } from '../models/projectJobLock.model.js';
import { connectMongo, disconnectMongo } from '../platform/mongo.js';
import { workerSmokeCheckHandlerRegistration } from './workerSmokeCheckJob.js';
import { connectedRepoPullHandlerRegistration } from './connectedRepoPullJob.js';
import { agedOrgDataCleanupHandlerRegistration } from './agedOrgDataCleanupJob.js';
import { CONVERSATION_MODELS } from '../modules/conversation/index.js';
import { WORKER_HEARTBEAT_INTERVAL_MS, assertWorkerLeaseTimingSafe } from './workerConfig.js';
import { JOB_MODELS, NOTIFICATION_MODELS, PROJECT_ACTIVITY_MODELS } from '../modules/masters/index.js';
import { attachShutdownSignals, registerProcessHandlers, registerShutdownHook } from '../platform/shutdown.js';
import { buildWorkerId, startSchedule, registerJobHandler, clearJobHandlersForTests } from './schedule.js';
import { SOURCE_MODELS, DOCUMENT_MODELS, KNOWLEDGE_MODELS, REPOSITORY_MODELS } from '../modules/knowledge/index.js';
import { projectKnowledgeBuildHandlerRegistration, projectKnowledgeRebuildHandlerRegistration } from './projectKnowledgeBuildJob.js';

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
 * Boots the worker: process handlers → config → Mongo → handlers → schedule → shutdown.
 * @param {object} [deps] Optional seams for unit tests.
 * @returns {Promise<{
 *   workerId: string,
 *   stopRuntime: () => Promise<void>,
 *   runtime: ReturnType<typeof startSchedule>,
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
    register(workerSmokeCheckHandlerRegistration);
    register(projectKnowledgeBuildHandlerRegistration);
    register(projectKnowledgeRebuildHandlerRegistration);
    register(connectedRepoPullHandlerRegistration);
    register(agedOrgDataCleanupHandlerRegistration);
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

  const start = deps.startSchedule ?? deps.startWorkerRuntime ?? startSchedule;
  const scheduleOverridden = deps.startSchedule != null || deps.startWorkerRuntime != null;
  const enableEnqueueTicks = deps.enableEnqueueTicks ?? deps.enableRepoSyncScheduler ?? !scheduleOverridden;
  const runtime = start({
    workerId,
    log,
    setInterval: deps.setInterval,
    clearInterval: deps.clearInterval,
    maxConcurrentJobs: deps.maxConcurrentJobs,
    pollIntervalMs: deps.pollIntervalMs,
    heartbeatIntervalMs: deps.heartbeatIntervalMs,
    sweepIntervalMs: deps.sweepIntervalMs,
    drainTimeoutMs: deps.drainTimeoutMs,
    enableEnqueueTicks,
    enqueueDueRepositorySyncs: deps.enqueueDueRepositorySyncs,
    enqueueDueAgedOrgDataCleanupJobs: deps.enqueueDueAgedOrgDataCleanupJobs,
    sweepExpiredQueuedMessages: deps.sweepExpiredQueuedMessages,
  });

  const registerHook = deps.registerShutdownHook ?? registerShutdownHook;
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

const isWorkerProcessEntry = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isWorkerProcessEntry) {
  startWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
