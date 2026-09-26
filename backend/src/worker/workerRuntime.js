/**
 * Worker runtime — poll / heartbeat / sweep timers and in-flight job orchestration.
 */
import { randomBytes } from 'node:crypto';
import { Job } from '../models/job.model.js';
import { appendJobEvent, emitNotificationsForJobTerminal, recordProjectActivitiesForJobTerminal } from '../modules/masters/index.js';
import { getJobHandler, listRegisteredJobTypes } from './handlerRegistry.js';
import {
  claimNextJob,
  finishJobCancelled,
  finishJobCompleted,
  finishJobFailed,
  recordJobClaimedEvent,
  releaseJobOnShutdown,
  requeueJobProjectBusy,
  requeueJobTemporaryFailure,
  resolveNextDueAt,
  saveJobCheckpoint,
  saveJobProgress,
} from './jobClaim.js';
import { heartbeatInFlightJob } from './jobHeartbeat.js';
import { sweepExpiredLeases } from './leaseSweeper.js';
import { acquireProjectJobLock, releaseProjectJobLock } from './projectJobLock.js';
import { classifyThrownFailure, decideFailureOutcome } from './retryPolicy.js';
import {
  WORKER_DRAIN_TIMEOUT_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_MAX_CONCURRENT_JOBS,
  WORKER_POLL_INTERVAL_MS,
  WORKER_SWEEP_INTERVAL_MS,
  assertWorkerLeaseTimingSafe,
} from './worker.constants.js';
import { createJobLogger } from './workerLogger.js';

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
 * Starts the claim / heartbeat / sweep runtime.
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
 * }} options Runtime options.
 * @returns {{
 *   workerId: string,
 *   stop: () => Promise<void>,
 *   getInFlightCount: () => number,
 *   claimOnceForTests: () => Promise<void>,
 *   heartbeatOnceForTests: () => Promise<void>,
 *   sweepOnceForTests: () => Promise<{ requeued: number, failed: number }>,
 * }}
 */
export function startWorkerRuntime(options) {
  assertWorkerLeaseTimingSafe();

  const log = options.log;
  const workerId = options.workerId;
  const schedule = options.setInterval ?? setInterval;
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
        log.debug?.({ workerId, inFlight: inFlight.size }, 'worker poll empty');
        return;
      }
      await recordJobClaimedEvent(job);
      log.info?.(
        {
          workerId,
          jobId: String(job._id),
          jobType: job.jobType,
          attempt: job.attempt,
        },
        'job claimed',
      );
      void executeClaimedJob(job);
    } catch (error) {
      log.error?.(
        {
          workerId,
          errName: error instanceof Error ? error.name : 'Error',
          errMessage: error instanceof Error ? error.message : String(error),
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
   * @returns {Promise<void>}
   */
  async function executeClaimedJob(job) {
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
      workerId,
      jobId,
      jobType: job.jobType,
      orgId: String(job.orgId),
      projectId: String(job.projectId),
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
           * Reads whether cancel was requested (Phase 22 sets the flag).
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
          jobLog.error?.({ handler: handler.type, errMessage: classified.message }, 'unclassified handler error treated as temporary');
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
            jobLog.error?.(
              {
                errName: releaseError instanceof Error ? releaseError.name : 'Error',
              },
              'failed to release project job lock',
            );
          }
        }
        inFlight.delete(jobId);
      }
    })();

    // Cover the window before the exclusive lock is acquired so concurrency accounts for it.
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
            errName: error instanceof Error ? error.name : 'Error',
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
          errName: error instanceof Error ? error.name : 'Error',
        },
        'lease sweeper failed',
      );
      return { requeued: 0, failed: 0 };
    }
  }

  const pollTimer = schedule(() => {
    void pollOnce();
  }, pollIntervalMs);
  const heartbeatTimer = schedule(() => {
    void heartbeatOnce();
  }, heartbeatIntervalMs);
  const sweepTimer = schedule(() => {
    void sweepOnce();
  }, sweepIntervalMs);

  for (const timer of [pollTimer, heartbeatTimer, sweepTimer]) {
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
            errName: error instanceof Error ? error.name : 'Error',
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
