/**
 * Atomic claim and job finish / requeue / cancel transitions.
 */
import mongoose from 'mongoose';
import { Job } from '../models/job.model.js';
import { appendJobEvent } from '../modules/masters/index.js';
import { ROW_STATUS_ACTIVE } from '../platform/data/index.js';
import { WORKER_LEASE_TTL_MS, WORKER_PROJECT_BUSY_RETRY_MS } from './worker.constants.js';
import {
  WORKER_MSG_CLAIMED,
  WORKER_EVENT_CLAIMED,
  WORKER_MSG_CANCELLED,
  WORKER_MSG_COMPLETED,
  WORKER_EVENT_CANCELLED,
  WORKER_EVENT_COMPLETED,
  WORKER_MSG_INTERRUPTED,
  WORKER_MSG_PROJECT_BUSY,
  WORKER_MSG_FAILED_ATTEMPTS,
  WORKER_MSG_RETRY_SCHEDULED,
  WORKER_MSG_FAILED_PERMANENT,
  WORKER_EVENT_RETRY_SCHEDULED,
  WORKER_MSG_RELEASED_SHUTDOWN,
  WORKER_EVENT_FAILED_PERMANENT,
  WORKER_MSG_COMPLETED_WARNINGS,
  WORKER_EVENT_INTERRUPTED_REQUEUED,
  WORKER_EVENT_RELEASED_ON_SHUTDOWN,
  WORKER_EVENT_PROJECT_BUSY_REQUEUED,
  WORKER_EVENT_COMPLETED_WITH_WARNINGS,
  WORKER_EVENT_FAILED_ATTEMPTS_EXHAUSTED,
} from './worker.events.js';

/**
 * Atomically claims the next due pending job among registered types.
 * @param {{
 *   workerId: string,
 *   registeredTypes: string[],
 *   leaseTtlMs?: number,
 * }} input Claim inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function claimNextJob(input) {
  if (!input.registeredTypes || input.registeredTypes.length === 0) {
    return null;
  }
  const leaseTtlMs = input.leaseTtlMs ?? WORKER_LEASE_TTL_MS;

  return Job.findOneAndUpdate(
    {
      status: ROW_STATUS_ACTIVE,
      jobStatus: { $in: ['pending', 'retrying'] },
      jobType: { $in: input.registeredTypes },
      $expr: { $lte: ['$scheduledAt', '$$NOW'] },
    },
    [
      {
        $set: {
          jobStatus: 'running',
          workerId: input.workerId,
          heartbeatAt: '$$NOW',
          leaseExpiresAt: { $add: ['$$NOW', leaseTtlMs] },
          startedAt: { $ifNull: ['$startedAt', '$$NOW'] },
          attempt: { $add: ['$attempt', 1] },
          failureClass: null,
          failureCode: null,
          updatedAt: '$$NOW',
        },
      },
    ],
    {
      sort: { scheduledAt: 1, createdAt: 1 },
      returnDocument: 'after',
      updatePipeline: true,
    },
  ).exec();
}

/**
 * Writes the claimed event for a job.
 * @param {import('mongoose').Document} job Claimed job document.
 * @returns {Promise<void>}
 */
export async function recordJobClaimedEvent(job) {
  await appendJobEvent({
    orgId: job.orgId,
    projectId: job.projectId,
    jobId: job._id,
    eventCode: WORKER_EVENT_CLAIMED,
    severity: 'info',
    message: WORKER_MSG_CLAIMED,
    data: { attempt: job.attempt, maxAttempts: job.maxAttempts },
    correlationId: job.correlationId ?? null,
  });
}

/**
 * Returns a claimed job to pending because the project writer lock is busy.
 * Decrements attempt so busy waits do not burn the attempt budget.
 * @param {{
 *   job: import('mongoose').Document,
 *   workerId: string,
 *   busyRetryMs?: number,
 * }} input Requeue inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function requeueJobProjectBusy(input) {
  const busyRetryMs = input.busyRetryMs ?? WORKER_PROJECT_BUSY_RETRY_MS;
  const job = input.job;

  const updated = await Job.findOneAndUpdate(
    {
      _id: job._id,
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [
      {
        $set: {
          jobStatus: 'pending',
          workerId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          attempt: { $max: [{ $subtract: ['$attempt', 1] }, 0] },
          scheduledAt: { $add: ['$$NOW', busyRetryMs] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();

  if (updated) {
    await appendJobEvent({
      orgId: updated.orgId,
      projectId: updated.projectId,
      jobId: updated._id,
      eventCode: WORKER_EVENT_PROJECT_BUSY_REQUEUED,
      severity: 'info',
      message: WORKER_MSG_PROJECT_BUSY,
      data: { retryAfterMs: busyRetryMs },
      correlationId: updated.correlationId ?? null,
    });
  }
  return updated;
}

/**
 * Marks a job completed (or completed_with_warnings).
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 *   result: 'completed' | 'completed_with_warnings',
 *   summary?: object,
 *   partialSuccess?: boolean,
 * }} input Finish inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function finishJobCompleted(input) {
  const jobStatus = input.result;
  const updated = await Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [
      {
        $set: {
          jobStatus,
          workerId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          completedAt: '$$NOW',
          partialSuccess: input.partialSuccess === true || jobStatus === 'completed_with_warnings',
          failureClass: null,
          failureCode: null,
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();

  if (updated) {
    const withWarnings = jobStatus === 'completed_with_warnings';
    await appendJobEvent({
      orgId: updated.orgId,
      projectId: updated.projectId,
      jobId: updated._id,
      eventCode: withWarnings ? WORKER_EVENT_COMPLETED_WITH_WARNINGS : WORKER_EVENT_COMPLETED,
      severity: withWarnings ? 'warning' : 'info',
      message: withWarnings ? WORKER_MSG_COMPLETED_WARNINGS : WORKER_MSG_COMPLETED,
      data: input.summary && typeof input.summary === 'object' ? input.summary : {},
      correlationId: updated.correlationId ?? null,
    });
  }
  return updated;
}

/**
 * Fails a job permanently (or attempts exhausted).
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 *   failureClass: string,
 *   failureCode: string,
 *   message: string,
 *   attemptsExhausted?: boolean,
 * }} input Fail inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function finishJobFailed(input) {
  const updated = await Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [
      {
        $set: {
          jobStatus: 'failed',
          workerId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          completedAt: '$$NOW',
          failureClass: input.failureClass,
          failureCode: input.failureCode,
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();

  if (updated) {
    const exhausted = input.attemptsExhausted === true;
    await appendJobEvent({
      orgId: updated.orgId,
      projectId: updated.projectId,
      jobId: updated._id,
      eventCode: exhausted ? WORKER_EVENT_FAILED_ATTEMPTS_EXHAUSTED : WORKER_EVENT_FAILED_PERMANENT,
      severity: 'error',
      message: exhausted ? WORKER_MSG_FAILED_ATTEMPTS : input.message || WORKER_MSG_FAILED_PERMANENT,
      data: {
        attempt: updated.attempt,
        maxAttempts: updated.maxAttempts,
        failureCode: input.failureCode,
        failureClass: input.failureClass,
      },
      correlationId: updated.correlationId ?? null,
    });
  }
  return updated;
}

/**
 * Requeues a running job after a temporary failure (backoff via scheduledAt).
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 *   delayMs: number,
 *   failureCode: string,
 *   message?: string,
 * }} input Requeue inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function requeueJobTemporaryFailure(input) {
  const updated = await Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [
      {
        $set: {
          jobStatus: 'pending',
          workerId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          failureClass: 'temporary',
          failureCode: input.failureCode,
          scheduledAt: { $add: ['$$NOW', input.delayMs] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();

  if (updated) {
    await appendJobEvent({
      orgId: updated.orgId,
      projectId: updated.projectId,
      jobId: updated._id,
      eventCode: WORKER_EVENT_RETRY_SCHEDULED,
      severity: 'warning',
      message: input.message || WORKER_MSG_RETRY_SCHEDULED,
      data: {
        attempt: updated.attempt,
        maxAttempts: updated.maxAttempts,
        delayMs: input.delayMs,
        failureCode: input.failureCode,
      },
      correlationId: updated.correlationId ?? null,
    });
  }
  return updated;
}

/**
 * Requeues a running job after lease expiry / crash (sweeper path).
 * Conditional on still running so concurrent sweepers only win once.
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   delayMs: number,
 * }} input Requeue inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function requeueJobInterrupted(input) {
  const updated = await Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      $expr: { $lt: ['$leaseExpiresAt', '$$NOW'] },
    },
    [
      {
        $set: {
          jobStatus: 'pending',
          workerId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          scheduledAt: { $add: ['$$NOW', input.delayMs] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();

  if (updated) {
    await appendJobEvent({
      orgId: updated.orgId,
      projectId: updated.projectId,
      jobId: updated._id,
      eventCode: WORKER_EVENT_INTERRUPTED_REQUEUED,
      severity: 'warning',
      message: WORKER_MSG_INTERRUPTED,
      data: { attempt: updated.attempt, maxAttempts: updated.maxAttempts },
      correlationId: updated.correlationId ?? null,
    });
  }
  return updated;
}

/**
 * Fails a lease-expired job when attempts are exhausted (sweeper path).
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   failureCode: string,
 * }} input Fail inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function failJobLeaseExpired(input) {
  const updated = await Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      $expr: { $lt: ['$leaseExpiresAt', '$$NOW'] },
    },
    [
      {
        $set: {
          jobStatus: 'failed',
          workerId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          completedAt: '$$NOW',
          failureClass: 'temporary',
          failureCode: input.failureCode,
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();

  if (updated) {
    await appendJobEvent({
      orgId: updated.orgId,
      projectId: updated.projectId,
      jobId: updated._id,
      eventCode: WORKER_EVENT_FAILED_ATTEMPTS_EXHAUSTED,
      severity: 'error',
      message: WORKER_MSG_FAILED_ATTEMPTS,
      data: {
        attempt: updated.attempt,
        maxAttempts: updated.maxAttempts,
        failureCode: input.failureCode,
      },
      correlationId: updated.correlationId ?? null,
    });
  }
  return updated;
}

/**
 * Releases an in-flight job back to pending on graceful shutdown.
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 * }} input Release inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function releaseJobOnShutdown(input) {
  const updated = await Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [
      {
        $set: {
          jobStatus: 'pending',
          workerId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          scheduledAt: '$$NOW',
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();

  if (updated) {
    await appendJobEvent({
      orgId: updated.orgId,
      projectId: updated.projectId,
      jobId: updated._id,
      eventCode: WORKER_EVENT_RELEASED_ON_SHUTDOWN,
      severity: 'info',
      message: WORKER_MSG_RELEASED_SHUTDOWN,
      data: { attempt: updated.attempt },
      correlationId: updated.correlationId ?? null,
    });
  }
  return updated;
}

/**
 * Marks a running job cancelled when cancel was requested.
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 * }} input Cancel inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function finishJobCancelled(input) {
  const updated = await Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [
      {
        $set: {
          jobStatus: 'cancelled',
          workerId: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          completedAt: '$$NOW',
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();

  if (updated) {
    await appendJobEvent({
      orgId: updated.orgId,
      projectId: updated.projectId,
      jobId: updated._id,
      eventCode: WORKER_EVENT_CANCELLED,
      severity: 'info',
      message: WORKER_MSG_CANCELLED,
      data: {},
      correlationId: updated.correlationId ?? null,
    });
  }
  return updated;
}

/**
 * Persists a stage checkpoint for the owning worker.
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 *   checkpoint: { lastCompletedStage: string, cursor?: unknown, updatedAt?: Date },
 *   currentStage?: string | null,
 * }} input Checkpoint inputs.
 * @returns {Promise<boolean>}
 */
export async function saveJobCheckpoint(input) {
  /** @type {{ lastCompletedStage: string, updatedAt: Date, cursor?: unknown }} */
  const checkpoint = {
    lastCompletedStage: input.checkpoint.lastCompletedStage,
    updatedAt: input.checkpoint.updatedAt ?? new Date(),
  };
  if (Object.prototype.hasOwnProperty.call(input.checkpoint, 'cursor')) {
    checkpoint.cursor = input.checkpoint.cursor;
  }

  /** @type {Record<string, unknown>} */
  const setFields = {
    stageCheckpoint: checkpoint,
  };
  if (input.currentStage !== undefined) {
    setFields.currentStage = input.currentStage;
  }

  const result = await Job.updateOne(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [{ $set: { ...setFields, updatedAt: '$$NOW' } }],
    { updatePipeline: true },
  ).exec();
  return result.matchedCount > 0;
}

/**
 * Persists progress counters for the owning worker while the job is running.
 * @param {{
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   workerId: string,
 *   progressCounters: {
 *     itemsProcessed: number,
 *     itemsFailed: number,
 *     warningCount: number,
 *     excludedCount: number,
 *   },
 *   currentStage?: string | null,
 *   partialSuccess?: boolean,
 * }} input Progress fields.
 * @returns {Promise<boolean>}
 */
export async function saveJobProgress(input) {
  /** @type {Record<string, unknown>} */
  const setFields = {
    progressCounters: {
      itemsProcessed: Math.max(0, Math.floor(input.progressCounters.itemsProcessed ?? 0)),
      itemsFailed: Math.max(0, Math.floor(input.progressCounters.itemsFailed ?? 0)),
      warningCount: Math.max(0, Math.floor(input.progressCounters.warningCount ?? 0)),
      excludedCount: Math.max(0, Math.floor(input.progressCounters.excludedCount ?? 0)),
    },
  };
  if (input.currentStage !== undefined) {
    setFields.currentStage = input.currentStage;
  }
  if (typeof input.partialSuccess === 'boolean') {
    setFields.partialSuccess = input.partialSuccess;
  }

  const result = await Job.updateOne(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      workerId: input.workerId,
    },
    [{ $set: { ...setFields, updatedAt: '$$NOW' } }],
    { updatePipeline: true },
  ).exec();
  return result.matchedCount > 0;
}

/**
 * Schedules the job's next occurrence (for recurring handlers) after completion.
 * Creates nothing — callers enqueue a new pending job via jobs module when needed.
 * This helper only updates scheduledAt on a still-running job before finish if desired;
 * preferred path is enqueue-next after complete. Kept as a no-op placeholder API surface
 * for handlers that want a delay computed from now.
 * @param {Date | number} nextDueAt Absolute date or delay ms from now.
 * @returns {Date}
 */
export function resolveNextDueAt(nextDueAt) {
  if (nextDueAt instanceof Date) {
    return nextDueAt;
  }
  if (typeof nextDueAt === 'number' && Number.isFinite(nextDueAt)) {
    return new Date(Date.now() + nextDueAt);
  }
  throw new TypeError('nextDueAt must be a Date or delay in milliseconds');
}
