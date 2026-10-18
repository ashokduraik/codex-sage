/**
 * Worker schedule — handler registry, all timers (poll / lease / enqueue), claim→run→finish loop.
 */
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { Job } from '../models/job.model.js';
import { caughtErrorFields } from '../platform/errors.js';
import { ROW_STATUS_ACTIVE } from '../platform/data/index.js';
import { computeRetryBackoffMs, classifyThrownFailure, decideFailureOutcome } from './jobFailure.js';
import { acquireProjectJobLock, releaseProjectJobLock, refreshProjectJobLock } from './projectLock.js';
import { enqueueDueRepositorySyncs, REPO_SYNC_SCHEDULER_TICK_MS } from '../modules/knowledge/index.js';
import { sweepExpiredQueuedMessages, QUEUED_MESSAGE_SWEEP_INTERVAL_MS } from '../modules/conversation/index.js';
import { enqueueDueAgedOrgDataCleanupJobs, AGED_ORG_DATA_CLEANUP_SCHEDULER_TICK_MS } from './agedOrgDataCleanupJob.js';
import {
  appendJobEvent,
  findProjectById,
  findOrganizationById,
  emitNotificationsForJobTerminal,
  recordProjectActivitiesForJobTerminal,
} from '../modules/masters/index.js';
import {
  createJobLogger,
  WORKER_LEASE_TTL_MS,
  WORKER_MAX_ATTEMPTS,
  WORKER_DRAIN_TIMEOUT_MS,
  WORKER_POLL_INTERVAL_MS,
  WORKER_SWEEP_INTERVAL_MS,
  WORKER_LEASE_EXPIRED_CODE,
  WORKER_MAX_CONCURRENT_JOBS,
  assertWorkerLeaseTimingSafe,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from './workerConfig.js';
import {
  claimNextJob,
  finishJobFailed,
  saveJobProgress,
  resolveNextDueAt,
  saveJobCheckpoint,
  finishJobCancelled,
  finishJobCompleted,
  failJobLeaseExpired,
  releaseJobOnShutdown,
  recordJobClaimedEvent,
  requeueJobInterrupted,
  requeueJobProjectBusy,
  requeueJobTemporaryFailure,
} from './jobState.js';

/** @typedef {'project' | 'none'} ExclusiveScope */

/**
 * @typedef {{
 *   type: string,
 *   exclusiveScope: ExclusiveScope,
 *   maxAttempts?: number,
 *   run: (context: object) => Promise<{
 *     result: 'completed' | 'completed_with_warnings' | 'deferred',
 *     summary?: object,
 *   }>,
 * }} JobHandlerRegistration
 */

/** @type {Map<string, JobHandlerRegistration>} */
const handlersByType = new Map();

/**
 * Registers a handler for a job type. Must run before the first claim poll.
 * @param {JobHandlerRegistration} registration Handler definition.
 * @throws {Error} When type is missing or already registered.
 */
export function registerJobHandler(registration) {
  if (!registration || typeof registration.type !== 'string' || registration.type.length === 0) {
    throw new Error('registerJobHandler requires a non-empty type');
  }
  if (typeof registration.run !== 'function') {
    throw new Error(`registerJobHandler(${registration.type}): run must be a function`);
  }
  if (registration.exclusiveScope !== 'project' && registration.exclusiveScope !== 'none') {
    throw new Error(`registerJobHandler(${registration.type}): exclusiveScope must be 'project' or 'none'`);
  }
  if (handlersByType.has(registration.type)) {
    throw new Error(`Job handler already registered for type: ${registration.type}`);
  }
  handlersByType.set(registration.type, {
    type: registration.type,
    exclusiveScope: registration.exclusiveScope,
    maxAttempts: registration.maxAttempts,
    run: registration.run,
  });
}

/**
 * Looks up a registered handler by job type.
 * @param {string} jobType Job type string.
 * @returns {JobHandlerRegistration | undefined}
 */
export function getJobHandler(jobType) {
  return handlersByType.get(jobType);
}

/**
 * Returns registered job type strings for the claim filter.
 * @returns {string[]}
 */
export function listRegisteredJobTypes() {
  return [...handlersByType.keys()];
}

/**
 * Clears all registrations (unit tests only).
 */
export function clearJobHandlersForTests() {
  handlersByType.clear();
}

/**
 * Builds a worker id that stays unique across fast restarts.
 * @param {{ hostname: string, pid: number, bootSuffix?: string }} input Identity parts.
 * @returns {string}
 */
export function buildWorkerId(input) {
  const suffix = input.bootSuffix ?? randomBytes(2).toString('hex');
  return `${input.hostname}-${input.pid}-${suffix}`;
}

/**
 * Refreshes heartbeat/lease for a job when workerId still matches.
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 *   leaseTtlMs?: number,
 * }} input Heartbeat inputs.
 * @returns {Promise<boolean>} True when ownership is still held.
 */
export async function refreshJobLease(input) {
  const leaseTtlMs = input.leaseTtlMs ?? WORKER_LEASE_TTL_MS;
  const result = await Job.updateOne(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [
      {
        $set: {
          heartbeatAt: '$$NOW',
          leaseExpiresAt: { $add: ['$$NOW', leaseTtlMs] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { updatePipeline: true },
  ).exec();
  return result.matchedCount > 0;
}

/**
 * Heartbeats one in-flight job: refresh lease, then project lock when exclusive.
 * @param {{
 *   jobId: string,
 *   workerId: string,
 *   orgId: string,
 *   projectId: string,
 *   holdsProjectLock: boolean,
 *   leaseTtlMs?: number,
 * }} input Heartbeat context.
 * @returns {Promise<{ owned: boolean }>}
 */
export async function heartbeatInFlightJob(input) {
  const owned = await refreshJobLease({
    jobId: input.jobId,
    workerId: input.workerId,
    leaseTtlMs: input.leaseTtlMs,
  });
  if (!owned) {
    return { owned: false };
  }
  if (input.holdsProjectLock) {
    await refreshProjectJobLock({
      orgId: input.orgId,
      projectId: input.projectId,
      jobId: input.jobId,
      workerId: input.workerId,
      leaseTtlMs: input.leaseTtlMs,
    });
  }
  return { owned: true };
}

/**
 * Scans for expired leases and requeues or fails each job at most once.
 * @param {{ log?: object }} [options] Optional logger.
 * @returns {Promise<{ requeued: number, failed: number }>}
 */
export async function sweepExpiredLeases(options = {}) {
  const log = options.log;
  const expired = await Job.aggregate([
    {
      $match: {
        status: ROW_STATUS_ACTIVE,
        jobStatus: 'running',
        $expr: { $lt: ['$leaseExpiresAt', '$$NOW'] },
      },
    },
  ]);

  let requeued = 0;
  let failed = 0;

  for (const job of expired) {
    const maxAttempts = typeof job.maxAttempts === 'number' && job.maxAttempts >= 1 ? job.maxAttempts : WORKER_MAX_ATTEMPTS;
    const attempt = typeof job.attempt === 'number' ? job.attempt : 0;

    try {
      if (attempt < maxAttempts) {
        const delayMs = computeRetryBackoffMs(Math.max(1, attempt));
        const updated = await requeueJobInterrupted({
          jobId: job._id,
          delayMs,
        });
        if (updated) {
          requeued += 1;
          await releaseProjectJobLock({
            orgId: updated.orgId,
            projectId: updated.projectId,
            jobId: updated._id,
          });
          log?.info?.({ jobId: String(updated._id), attempt: updated.attempt }, 'lease expired; job requeued');
        }
      } else {
        const updated = await failJobLeaseExpired({
          jobId: job._id,
          failureCode: WORKER_LEASE_EXPIRED_CODE,
        });
        if (updated) {
          failed += 1;
          await releaseProjectJobLock({
            orgId: updated.orgId,
            projectId: updated.projectId,
            jobId: updated._id,
          });
          log?.info?.({ jobId: String(updated._id), attempt: updated.attempt }, 'lease expired; attempts exhausted');
        }
      }
    } catch (error) {
      log?.error?.(
        {
          jobId: String(job._id),
          ...caughtErrorFields(error),
        },
        'lease sweeper failed for job',
      );
    }
  }

  return { requeued, failed };
}

/**
 * Starts poll / heartbeat / lease-sweep timers and optional enqueue ticks.
 * @param {{
 *   workerId: string,
 *   log: object,
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 *   maxConcurrentJobs?: number,
 *   pollIntervalMs?: number,
 *   heartbeatIntervalMs?: number,
 *   sweepIntervalMs?: number,
 *   drainTimeoutMs?: number,
 *   projectBusyRetryMs?: number,
 *   enableEnqueueTicks?: boolean,
 *   enqueueDueRepositorySyncs?: typeof enqueueDueRepositorySyncs,
 *   enqueueDueAgedOrgDataCleanupJobs?: typeof enqueueDueAgedOrgDataCleanupJobs,
 *   sweepExpiredQueuedMessages?: typeof sweepExpiredQueuedMessages,
 * }} options Schedule options.
 * @returns {{
 *   workerId: string,
 *   stop: () => Promise<void>,
 *   getInFlightCount: () => number,
 *   claimOnceForTests: () => Promise<void>,
 *   heartbeatOnceForTests: () => Promise<void>,
 *   sweepOnceForTests: () => Promise<{ requeued: number, failed: number }>,
 * }}
 */
export function startSchedule(options) {
  assertWorkerLeaseTimingSafe();

  const log = options.log;
  const workerId = options.workerId;
  const scheduleTimer = options.setInterval ?? setInterval;
  const clear = options.clearInterval ?? clearInterval;
  const maxConcurrent = options.maxConcurrentJobs ?? WORKER_MAX_CONCURRENT_JOBS;
  const pollIntervalMs = options.pollIntervalMs ?? WORKER_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? WORKER_SWEEP_INTERVAL_MS;
  const drainTimeoutMs = options.drainTimeoutMs ?? WORKER_DRAIN_TIMEOUT_MS;
  const projectBusyRetryMs = options.projectBusyRetryMs;

  /** @type {Map<string, {
   *   job: import('mongoose').Document,
   *   abortController: AbortController,
   *   holdsProjectLock: boolean,
   *   runPromise: Promise<void>,
   * }>} */
  const inFlight = new Map();
  let acceptingClaims = true;
  let pollInProgress = false;

  /**
   * Polls for one job when a concurrency slot is free.
   * @returns {Promise<void>}
   */
  async function pollOnce() {
    if (!acceptingClaims || pollInProgress) {
      return;
    }
    if (inFlight.size >= maxConcurrent) {
      return;
    }
    pollInProgress = true;
    try {
      const registeredTypes = listRegisteredJobTypes();
      const job = await claimNextJob({ workerId, registeredTypes });
      if (!job) {
        return;
      }
      await recordJobClaimedEvent(job);
      const scopeNames = await resolveJobScopeDisplayNames(job.orgId, job.projectId);
      log.info?.(
        {
          jobId: String(job._id),
          jobType: job.jobType,
          orgName: scopeNames.orgName,
          projectName: scopeNames.projectName,
          attempt: job.attempt,
        },
        'job claimed',
      );
      void executeClaimedJob(job, scopeNames);
    } catch (error) {
      log.error?.(
        {
          workerId,
          ...caughtErrorFields(error),
        },
        'worker poll failed',
      );
    } finally {
      pollInProgress = false;
    }
  }

  /**
   * Runs the handler for a claimed job and tracks it while in flight.
   * @param {import('mongoose').Document} job Claimed job.
   * @param {{ orgName: string, projectName: string }} scopeNames Display names for logs.
   * @returns {Promise<void>}
   */
  async function executeClaimedJob(job, scopeNames) {
    const jobId = String(job._id);
    const abortController = new AbortController();
    const handler = getJobHandler(job.jobType);
    if (!handler) {
      await finishJobFailed({
        jobId,
        workerId,
        failureClass: 'permanent',
        failureCode: 'WORKER_UNKNOWN_JOB_TYPE',
        message: 'No handler is registered for this job type.',
      });
      return;
    }

    const jobLog = createJobLogger(log, {
      jobId,
      jobType: job.jobType,
      orgName: scopeNames.orgName,
      projectName: scopeNames.projectName,
      attempt: job.attempt,
      stage: job.currentStage,
      correlationId: job.correlationId,
    });

    let holdsProjectLock = false;
    /** @type {Promise<void>} */
    let settle = Promise.resolve();
    settle = (async () => {
      try {
        if (handler.exclusiveScope === 'project') {
          const lock = await acquireProjectJobLock({
            orgId: job.orgId,
            projectId: job.projectId,
            jobId: job._id,
            workerId,
          });
          if (!lock.acquired) {
            await requeueJobProjectBusy({
              job,
              workerId,
              busyRetryMs: projectBusyRetryMs,
            });
            jobLog.info?.({}, 'project busy; job requeued');
            return;
          }
          holdsProjectLock = true;
        }

        inFlight.set(jobId, {
          job,
          abortController,
          holdsProjectLock,
          runPromise: settle,
        });

        if (job.cancelRequestedAt) {
          await finishJobCancelled({ jobId, workerId });
          jobLog.info?.({}, 'job cancelled before handler');
          return;
        }

        const context = {
          job,
          stageCheckpoint: job.stageCheckpoint ?? null,
          log: jobLog,
          signal: abortController.signal,
          /**
           * Appends a JobEvent for this job.
           * @param {{ eventCode: string, severity: string, message: string, data?: object }} event Event fields.
           */
          async recordEvent(event) {
            await appendJobEvent({
              orgId: job.orgId,
              projectId: job.projectId,
              jobId: job._id,
              eventCode: event.eventCode,
              severity: event.severity,
              message: event.message,
              data: event.data ?? {},
              correlationId: job.correlationId ?? null,
            });
          },
          /**
           * Persists stage checkpoint for resume.
           * @param {{
           *   lastCompletedStage: string,
           *   cursor?: unknown,
           *   currentStage?: string | null,
           * }} checkpoint Checkpoint body.
           */
          async saveCheckpoint(checkpoint) {
            if (abortController.signal.aborted) {
              return;
            }
            await saveJobCheckpoint({
              jobId,
              workerId,
              checkpoint: {
                lastCompletedStage: checkpoint.lastCompletedStage,
                ...(Object.prototype.hasOwnProperty.call(checkpoint, 'cursor') ? { cursor: checkpoint.cursor } : {}),
              },
              currentStage: checkpoint.currentStage ?? checkpoint.lastCompletedStage,
            });
          },
          /**
           * Flushes progress counters for the UI while the job is running.
           * @param {{
           *   itemsProcessed: number,
           *   itemsFailed: number,
           *   warningCount: number,
           *   excludedCount: number,
           *   currentStage?: string | null,
           *   partialSuccess?: boolean,
           * }} progress Progress payload.
           */
          async saveProgress(progress) {
            if (abortController.signal.aborted) {
              return;
            }
            await saveJobProgress({
              jobId,
              workerId,
              progressCounters: {
                itemsProcessed: progress.itemsProcessed,
                itemsFailed: progress.itemsFailed,
                warningCount: progress.warningCount,
                excludedCount: progress.excludedCount,
              },
              currentStage: progress.currentStage,
              partialSuccess: progress.partialSuccess,
            });
          },
          /**
           * Reads whether cancel was requested.
           * @returns {Promise<boolean>}
           */
          async isCancelRequested() {
            if (job.cancelRequestedAt) {
              return true;
            }
            try {
              const fresh = await Job.findById(job._id).select('cancelRequestedAt').lean().exec();
              return Boolean(fresh?.cancelRequestedAt);
            } catch {
              return false;
            }
          },
          /**
           * Helper for recurring handlers to compute the next due time.
           * @param {Date | number} nextDueAt Absolute date or delay ms.
           * @returns {Date}
           */
          scheduleNextOccurrence(nextDueAt) {
            return resolveNextDueAt(nextDueAt);
          },
        };

        const outcome = await handler.run(context);

        if (outcome?.result === 'deferred') {
          jobLog.info?.({}, 'job deferred by handler');
          return;
        }

        if (abortController.signal.aborted) {
          return;
        }

        if (await context.isCancelRequested()) {
          await finishJobCancelled({ jobId, workerId });
          jobLog.info?.({}, 'job cancelled after handler');
          return;
        }

        const completedResult = outcome?.result === 'completed_with_warnings' ? 'completed_with_warnings' : 'completed';
        const completedJob = await finishJobCompleted({
          jobId,
          workerId,
          result: completedResult,
          summary: outcome?.summary,
        });
        if (completedJob) {
          await emitNotificationsForJobTerminal({
            job: completedJob,
            result: completedResult,
            log: jobLog,
          });
          await recordProjectActivitiesForJobTerminal({ job: completedJob, log: jobLog });
        }
        jobLog.info?.({ result: outcome?.result ?? 'completed' }, 'job completed');
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }
        const classified = classifyThrownFailure(error);
        if (classified.unclassified) {
          jobLog.error?.({ handler: handler.type, ...caughtErrorFields(error) }, 'unclassified handler error treated as temporary');
        }
        const decision = decideFailureOutcome({
          failure: classified,
          attempt: job.attempt,
          maxAttempts: handler.maxAttempts ?? job.maxAttempts,
        });
        if (decision.action === 'requeue') {
          await requeueJobTemporaryFailure({
            jobId,
            workerId,
            delayMs: decision.delayMs,
            failureCode: decision.code,
            message: decision.message,
          });
          jobLog.info?.({ delayMs: decision.delayMs, failureCode: decision.code }, 'job requeued after temporary failure');
        } else {
          const failedJob = await finishJobFailed({
            jobId,
            workerId,
            failureClass: decision.failureClass,
            failureCode: decision.code,
            message: decision.message,
            attemptsExhausted: classified.failureClass === 'temporary',
          });
          if (failedJob) {
            await emitNotificationsForJobTerminal({
              job: failedJob,
              result: 'failed',
              failureClass: decision.failureClass,
              log: jobLog,
            });
          }
          jobLog.info?.({ failureClass: decision.failureClass, failureCode: decision.code }, 'job failed');
        }
      } finally {
        if (holdsProjectLock) {
          try {
            await releaseProjectJobLock({
              orgId: job.orgId,
              projectId: job.projectId,
              jobId: job._id,
            });
          } catch (releaseError) {
            jobLog.error?.(caughtErrorFields(releaseError), 'failed to release project job lock');
          }
        }
        inFlight.delete(jobId);
      }
    })();

    if (!inFlight.has(jobId)) {
      inFlight.set(jobId, {
        job,
        abortController,
        holdsProjectLock: false,
        runPromise: settle,
      });
    }
    await settle;
  }

  /**
   * Heartbeats every in-flight job; aborts those that lost ownership.
   * @returns {Promise<void>}
   */
  async function heartbeatOnce() {
    const entries = [...inFlight.entries()];
    for (const [jobId, entry] of entries) {
      try {
        const result = await heartbeatInFlightJob({
          jobId,
          workerId,
          orgId: String(entry.job.orgId),
          projectId: String(entry.job.projectId),
          holdsProjectLock: entry.holdsProjectLock,
        });
        if (!result.owned) {
          log.warn?.({ workerId, jobId }, 'lost job lease; aborting handler');
          entry.abortController.abort();
        }
      } catch (error) {
        log.error?.(
          {
            workerId,
            jobId,
            ...caughtErrorFields(error),
          },
          'heartbeat failed; aborting job',
        );
        entry.abortController.abort();
      }
    }
  }

  /**
   * Runs one lease sweep.
   * @returns {Promise<{ requeued: number, failed: number }>}
   */
  async function sweepOnce() {
    try {
      return await sweepExpiredLeases({ log });
    } catch (error) {
      log.error?.(
        {
          workerId,
          ...caughtErrorFields(error),
        },
        'lease sweeper failed',
      );
      return { requeued: 0, failed: 0 };
    }
  }

  const pollTimer = scheduleTimer(() => {
    void pollOnce();
  }, pollIntervalMs);
  const heartbeatTimer = scheduleTimer(() => {
    void heartbeatOnce();
  }, heartbeatIntervalMs);
  const sweepTimer = scheduleTimer(() => {
    void sweepOnce();
  }, sweepIntervalMs);

  /** @type {ReturnType<typeof setInterval>[]} */
  const enqueueTimers = [];
  if (options.enableEnqueueTicks) {
    const enqueueDue = options.enqueueDueRepositorySyncs ?? enqueueDueRepositorySyncs;
    const enqueueCleanup = options.enqueueDueAgedOrgDataCleanupJobs ?? enqueueDueAgedOrgDataCleanupJobs;
    const sweepQueued = options.sweepExpiredQueuedMessages ?? sweepExpiredQueuedMessages;
    const repoTick = () => {
      enqueueDue({ log }).catch((err) => {
        log.error?.(caughtErrorFields(err), 'connected_repo_pull enqueue tick failed');
      });
    };
    const cleanupTick = () => {
      enqueueCleanup({ log }).catch((err) => {
        log.error?.(caughtErrorFields(err), 'aged_org_data_cleanup enqueue tick failed');
      });
    };
    const queuedExpiryTick = () => {
      sweepQueued({ log }).catch((err) => {
        log.error?.(caughtErrorFields(err), 'queued chat expiry sweep failed');
      });
    };
    repoTick();
    cleanupTick();
    queuedExpiryTick();
    enqueueTimers.push(
      scheduleTimer(repoTick, REPO_SYNC_SCHEDULER_TICK_MS),
      scheduleTimer(cleanupTick, AGED_ORG_DATA_CLEANUP_SCHEDULER_TICK_MS),
      scheduleTimer(queuedExpiryTick, QUEUED_MESSAGE_SWEEP_INTERVAL_MS),
    );
  }

  for (const timer of [pollTimer, heartbeatTimer, sweepTimer, ...enqueueTimers]) {
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      /** @type {{ unref: () => void }} */ (timer).unref();
    }
  }

  void pollOnce();

  /**
   * Stops timers, waits for drain, then releases remaining leases.
   * @returns {Promise<void>}
   */
  async function stop() {
    acceptingClaims = false;
    clear(pollTimer);
    clear(heartbeatTimer);
    clear(sweepTimer);
    for (const timer of enqueueTimers) {
      clear(timer);
    }

    const deadline = Date.now() + drainTimeoutMs;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    for (const [jobId, entry] of [...inFlight.entries()]) {
      entry.abortController.abort();
      try {
        await releaseJobOnShutdown({ jobId, workerId });
        if (entry.holdsProjectLock) {
          await releaseProjectJobLock({
            orgId: entry.job.orgId,
            projectId: entry.job.projectId,
            jobId: entry.job._id,
          });
        }
      } catch (error) {
        log.error?.(
          {
            workerId,
            jobId,
            ...caughtErrorFields(error),
          },
          'failed to release job on shutdown',
        );
      }
      inFlight.delete(jobId);
    }
  }

  return {
    workerId,
    stop,
    getInFlightCount: () => inFlight.size,
    claimOnceForTests: pollOnce,
    heartbeatOnceForTests: heartbeatOnce,
    sweepOnceForTests: sweepOnce,
  };
}

/** Alias so existing tests can import startWorkerRuntime from schedule. */
export const startWorkerRuntime = startSchedule;

/**
 * Resolves human-readable org and project names for worker job logs.
 * Falls back to the raw id string when the row is missing or lookup fails so logging
 * never blocks claim/run (unit tests without Mongo still claim successfully).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string | null | undefined} projectId Project id.
 * @returns {Promise<{ orgName: string, projectName: string }>}
 */
async function resolveJobScopeDisplayNames(orgId, projectId) {
  const orgIdText = String(orgId);
  const projectIdText = projectId == null ? '' : String(projectId);
  const fallback = {
    orgName: orgIdText,
    projectName: projectIdText || '(no project)',
  };
  // Avoid hanging when Mongo is not connected (unit tests / early boot).
  if (mongoose.connection.readyState !== 1) {
    return fallback;
  }
  try {
    const [organization, project] = await Promise.all([
      findOrganizationById(orgIdText),
      projectIdText ? findProjectById(orgIdText, projectIdText) : Promise.resolve(null),
    ]);
    const orgName = organization && typeof organization.name === 'string' && organization.name.trim() ? organization.name.trim() : orgIdText;
    const projectName = project && typeof project.name === 'string' && project.name.trim() ? project.name.trim() : projectIdText || '(no project)';
    return { orgName, projectName };
  } catch {
    return fallback;
  }
}
