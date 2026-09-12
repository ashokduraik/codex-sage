/**
 * Jobs repository — tenant + project scoped job and event persistence.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import {
  assertOrgId,
  decodeCursor,
  encodeCursor,
  ROW_STATUS_ACTIVE,
} from '../../platform/data/index.js';
import { Job } from './job.model.js';
import { JobEvent } from './jobEvent.model.js';
import {
  JOB_DEFAULT_MAX_ATTEMPTS,
  JOB_EVENT_CODE_ENQUEUED,
  JOB_EVENT_MESSAGE_MAX_LENGTH,
  JOB_ENQUEUED_MESSAGE,
  JOB_LIST_PAGE_SIZE_DEFAULT,
  JOB_LIST_PAGE_SIZE_MAX,
  JOB_STATUS_VALUES,
} from './jobs.constants.js';

/**
 * Clamps a requested page size into the allowed range.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampJobListLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return JOB_LIST_PAGE_SIZE_DEFAULT;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return JOB_LIST_PAGE_SIZE_DEFAULT;
  }
  return Math.min(Math.floor(parsed), JOB_LIST_PAGE_SIZE_MAX);
}

/**
 * Returns true when value is a known jobStatus.
 * @param {unknown} jobStatus Candidate status.
 * @returns {boolean}
 */
export function isKnownJobStatus(jobStatus) {
  return typeof jobStatus === 'string' && JOB_STATUS_VALUES.includes(jobStatus);
}

/**
 * Builds a keyset filter for createdAt/_id descending pages.
 * @param {{ t: string, i: string }} cursor Decoded cursor.
 * @returns {object}
 */
function keysetAfterCreatedAt(cursor) {
  const stamp = new Date(cursor.t);
  if (Number.isNaN(stamp.getTime())) {
    throw ApiError.fromCode('INVALID_CURSOR');
  }
  if (!mongoose.isValidObjectId(cursor.i)) {
    throw ApiError.fromCode('INVALID_CURSOR');
  }
  const id = new mongoose.Types.ObjectId(cursor.i);
  return {
    $or: [{ createdAt: { $lt: stamp } }, { createdAt: stamp, _id: { $lt: id } }],
  };
}

/**
 * Asserts event message length before write (never truncate).
 * @param {string} message Event message.
 * @throws {ApiError} VALIDATION_ERROR when over max length.
 */
export function assertJobEventMessageLength(message) {
  if (typeof message !== 'string' || message.length > JOB_EVENT_MESSAGE_MAX_LENGTH) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'message',
          message: `message must be at most ${JOB_EVENT_MESSAGE_MAX_LENGTH} characters`,
        },
      ],
    });
  }
}

/**
 * Inserts a pending job and its initial enqueued event.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId | string,
 *   jobType: string,
 *   createdBy?: import('mongoose').Types.ObjectId | string | null,
 *   correlationId?: string | null,
 *   sourceVersionId?: import('mongoose').Types.ObjectId | string | null,
 *   maxAttempts?: number,
 *   scheduledAt?: Date,
 * }} input Create fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<{ job: import('mongoose').Document, event: import('mongoose').Document }>}
 */
export async function insertPendingJob(input, options = {}) {
  assertOrgId(input.orgId);
  const now = input.scheduledAt instanceof Date ? input.scheduledAt : new Date();
  const maxAttempts =
    typeof input.maxAttempts === 'number' && input.maxAttempts >= 1
      ? input.maxAttempts
      : JOB_DEFAULT_MAX_ATTEMPTS;

  const job = new Job({
    orgId: input.orgId,
    projectId: input.projectId,
    jobType: input.jobType,
    jobStatus: 'pending',
    sourceVersionId: input.sourceVersionId ?? null,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
    correlationId: input.correlationId ?? null,
    workerId: null,
    attempt: 0,
    maxAttempts,
    heartbeatAt: null,
    leaseExpiresAt: null,
    scheduledAt: now,
    failureClass: null,
    failureCode: null,
    currentStage: null,
    stageCheckpoint: null,
    progressCounters: {
      itemsProcessed: 0,
      itemsFailed: 0,
      warningCount: 0,
      excludedCount: 0,
    },
    partialSuccess: false,
    cancelRequestedAt: null,
    startedAt: null,
    completedAt: null,
  });

  assertJobEventMessageLength(JOB_ENQUEUED_MESSAGE);

  const event = new JobEvent({
    orgId: input.orgId,
    projectId: input.projectId,
    jobId: job._id,
    eventCode: JOB_EVENT_CODE_ENQUEUED,
    severity: 'info',
    message: JOB_ENQUEUED_MESSAGE,
    data: {},
    correlationId: input.correlationId ?? null,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
  });

  if (options.session) {
    await job.save({ session: options.session });
    await event.save({ session: options.session });
  } else {
    await job.save();
    await event.save();
  }

  return { job, event };
}

/**
 * Finds an active job by id within an org.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} jobId Job id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findJobById(orgId, jobId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(jobId)) {
    return null;
  }
  return Job.findOne({ _id: jobId, orgId, status: ROW_STATUS_ACTIVE }).exec();
}

/**
 * Lists active jobs for a project with keyset pagination.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{
 *   cursor?: string,
 *   limit?: unknown,
 *   jobStatus?: string,
 * }} [filters] List filters.
 * @returns {Promise<{
 *   items: import('mongoose').Document[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }>}
 */
export async function listJobsByProject(orgId, projectId, filters = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
  }

  const limit = clampJobListLimit(filters.limit);
  /** @type {Record<string, unknown>} */
  const query = {
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    status: ROW_STATUS_ACTIVE,
  };

  if (filters.jobStatus !== undefined && filters.jobStatus !== null && filters.jobStatus !== '') {
    if (!isKnownJobStatus(filters.jobStatus)) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: [{ path: 'jobStatus', message: 'jobStatus is not a known value' }],
      });
    }
    query.jobStatus = filters.jobStatus;
  }

  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    Object.assign(query, keysetAfterCreatedAt(decoded));
  }

  const rows = await Job.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      t: last.createdAt.toISOString(),
      i: String(last._id),
    });
  }
  return { items, pageInfo: { nextCursor, hasMore } };
}

/**
 * Lists active events for a job in ascending createdAt order.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} jobId Job id.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function listEventsForJob(orgId, jobId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(jobId)) {
    return [];
  }
  return JobEvent.find({
    orgId,
    jobId: new mongoose.Types.ObjectId(String(jobId)),
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ createdAt: 1, _id: 1 })
    .exec();
}

/**
 * Appends a job event (used by createPendingJob and later worker phases).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId | string,
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   eventCode: string,
 *   severity: 'info' | 'warning' | 'error',
 *   message: string,
 *   data?: object,
 *   correlationId?: string | null,
 *   createdBy?: import('mongoose').Types.ObjectId | string | null,
 * }} input Event fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function appendJobEvent(input, options = {}) {
  assertOrgId(input.orgId);
  assertJobEventMessageLength(input.message);
  const event = new JobEvent({
    orgId: input.orgId,
    projectId: input.projectId,
    jobId: input.jobId,
    eventCode: input.eventCode,
    severity: input.severity,
    message: input.message,
    data: input.data && typeof input.data === 'object' ? input.data : {},
    correlationId: input.correlationId ?? null,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
  });
  if (options.session) {
    await event.save({ session: options.session });
  } else {
    await event.save();
  }
  return event;
}
