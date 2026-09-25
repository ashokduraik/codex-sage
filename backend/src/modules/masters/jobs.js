/**
 * masters/jobs.js — merged resource file.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { ApiError } from '../../platform/errors.js';
import { hasRequiredPermissions, recordAuditEvent } from '../access/index.js';
import {
  JOB_STATUS_VALUES,
  findJobById,
  insertPendingJob,
  listEventsForJob,
  listJobsByProject,
  projectJobProgress,
  JOB_MAX_USER_RETRIES,
  renderJobEventMessage,
  resolveJobRetryMode,
  appendJobEvent,
  beginUserRetry,
  cancelQueuedJob,
  findActiveJobForProject,
  requestRunningJobCancel,
} from './jobs.helper.js';
import { resolveProjectPermissions } from './projectMembers.js';
import { findProjectById } from './projects.js';
import { Job } from '../../models/job.model.js';
import { JobEvent } from '../../models/jobEvent.model.js';
import { z } from 'zod';

// --- from jobs/jobs.routes.js ---
/**
 * Job HTTP read and control routes under `/api/v1`.
 */
const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().optional(),
  jobStatus: z.enum(JOB_STATUS_VALUES).optional(),
});

const projectIdParamsSchema = z.object({
  projectId: z.string().min(1),
});

const jobIdParamsSchema = z.object({
  jobId: z.string().min(1),
});

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
export function zodDetails(error, emptyPath = 'query') {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    details.push({
      path: issue.path.join('.') || emptyPath,
      message: issue.message,
    });
  }
  return details;
}

/**
 * Registers job read and control routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function jobRoutes(app) {
  await jobControlRoutes(app);

  app.get(
    '/projects/:projectId/jobs',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission('projects.view'),
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      if (parsed.data.limit === 0) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'limit', message: 'limit must be a positive integer' }],
        });
      }
      return listProjectJobs(
        request.projectScope.orgId,
        request.projectScope.projectId,
        parsed.data,
      );
    },
  );

  app.get(
    '/jobs/:jobId',
    { config: { routeAccess: 'authenticated' } },
    async (request) => {
      const params = jobIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      return getJobById(
        /** @type {string} */ (request.principal.orgId),
        /** @type {string} */ (request.principal.userId),
        params.data.jobId,
        { requestMemo: request.projectAclMemo },
      );
    },
  );
}

// --- from jobs/jobControl.routes.js ---
/**
 * Job control HTTP routes — retry and cancel under `/api/v1`.
 */

/**
 * Parses and validates `:jobId` route params.
 * @param {unknown} params Fastify request.params.
 * @returns {{ jobId: string }}
 * @throws {ApiError} VALIDATION_ERROR when invalid.
 */
export function parseJobControlParams(params) {
  const parsed = jobIdParamsSchema.safeParse(params ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error, 'params') });
  }
  return parsed.data;
}

/**
 * Builds shared service context from the Fastify request.
 * @param {import('fastify').FastifyRequest} request Request.
 * @returns {object}
 */
function controlContext(request) {
  return {
    orgId: /** @type {string} */ (request.principal.orgId),
    userId: /** @type {string} */ (request.principal.userId),
    correlationId: request.id,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    log: request.log,
    requestMemo: request.projectAclMemo,
  };
}

/**
 * Registers job control routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function jobControlRoutes(app) {
  app.post(
    '/jobs/:jobId/retry',
    {
      config: {
        routeAccess: 'authenticated',
        requireIdempotencyKey: true,
      },
    },
    async (request, reply) => {
      const params = parseJobControlParams(request.params);
      if (!request.projectAclMemo) {
        request.projectAclMemo = new Map();
      }
      const result = await retryJob({
        ...controlContext(request),
        jobId: params.jobId,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.post(
    '/jobs/:jobId/cancel',
    {
      config: {
        routeAccess: 'authenticated',
      },
    },
    async (request, reply) => {
      const params = parseJobControlParams(request.params);
      if (!request.projectAclMemo) {
        request.projectAclMemo = new Map();
      }
      const result = await cancelJob({
        ...controlContext(request),
        jobId: params.jobId,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );
}

// --- from jobs/jobs.service.js ---
/**
 * Jobs service — enqueue helper and project-scoped read use cases.
 */
/**
 * Formats a date as ISO-8601, or null when missing.
 * @param {unknown} value Date or string.
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || value === '') {
    return null;
  }
  return String(value);
}

/**
 * Maps progressCounters to a plain object with numeric defaults.
 * @param {object | null | undefined} counters Stored counters.
 * @returns {{
 *   itemsProcessed: number,
 *   itemsFailed: number,
 *   warningCount: number,
 *   excludedCount: number,
 * }}
 */
function mapProgressCounters(counters) {
  return {
    itemsProcessed: counters?.itemsProcessed ?? 0,
    itemsFailed: counters?.itemsFailed ?? 0,
    warningCount: counters?.warningCount ?? 0,
    excludedCount: counters?.excludedCount ?? 0,
  };
}

/**
 * Maps stageCheckpoint for the detail response (never on list).
 * @param {object | null | undefined} checkpoint Stored checkpoint.
 * @returns {{
 *   lastCompletedStage: string | null,
 *   cursor?: unknown,
 *   updatedAt: string | null,
 * } | null}
 */
function mapStageCheckpoint(checkpoint) {
  if (checkpoint == null) {
    return null;
  }
  /** @type {{ lastCompletedStage: string | null, updatedAt: string | null, cursor?: unknown }} */
  const mapped = {
    lastCompletedStage: checkpoint.lastCompletedStage ?? null,
    updatedAt: toIsoOrNull(checkpoint.updatedAt),
  };
  if (Object.prototype.hasOwnProperty.call(checkpoint, 'cursor')) {
    mapped.cursor = checkpoint.cursor;
  }
  return mapped;
}

/**
 * Maps a JobEvent document to the API event DTO.
 * @param {object} event JobEvent document or lean object.
 * @returns {{
 *   eventCode: string,
 *   severity: string,
 *   message: string,
 *   data: object,
 *   createdAt: string | null,
 * }}
 */
export function mapJobEventToDto(event) {
  return {
    eventCode: event.eventCode,
    severity: event.severity,
    message: event.message,
    data:
      event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? { ...event.data }
        : {},
    createdAt: toIsoOrNull(event.createdAt),
  };
}

/**
 * Maps a job document to the list-item DTO (omits workerId and stageCheckpoint).
 * @param {object} job Job document or lean object.
 * @returns {object}
 */
export function mapJobToListDto(job) {
  return {
    id: String(job._id ?? job.id),
    jobType: job.jobType,
    jobStatus: job.jobStatus,
    currentStage: job.currentStage ?? null,
    failureClass: job.failureClass ?? null,
    partialSuccess: job.partialSuccess === true,
    progressCounters: mapProgressCounters(job.progressCounters),
    scheduledAt: toIsoOrNull(job.scheduledAt),
    createdAt: toIsoOrNull(job.createdAt),
    startedAt: toIsoOrNull(job.startedAt),
    completedAt: toIsoOrNull(job.completedAt),
  };
}

/**
 * Maps a job document plus events to the detail DTO.
 * Does not expose workerId (operational, not user-facing).
 * @param {object} job Job document or lean object.
 * @param {object[]} [events] Ordered JobEvent documents.
 * @returns {object}
 */
export function mapJobToDetailDto(job, events = []) {
  const progress = projectJobProgress(job, events);
  return {
    ...mapJobToListDto(job),
    projectId: String(job.projectId),
    sourceVersionId: job.sourceVersionId ? String(job.sourceVersionId) : null,
    stageCheckpoint: mapStageCheckpoint(job.stageCheckpoint),
    correlationId: job.correlationId ?? null,
    events: events.map(mapJobEventToDto),
    durationMs: progress.durationMs,
    percent: progress.percent,
    itemsProcessed: progress.itemsProcessed,
    itemsFailed: progress.itemsFailed,
    stages: progress.stages,
    warnings: progress.warnings,
    errors: progress.errors,
    retry: progress.retry,
    cancellation: progress.cancellation,
    knowledgeAvailability: progress.knowledgeAvailability,
  };
}

/**
 * Creates a pending job and its initial enqueued event (internal; no HTTP create).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   jobType: string,
 *   createdBy?: string | null,
 *   correlationId?: string | null,
 *   sourceVersionId?: string | null,
 *   maxAttempts?: number,
 *   scheduledAt?: Date,
 * }} input Create fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<{ jobId: string, eventId: string }>}
 */
export async function createPendingJob(input, options = {}) {
  const { job, event } = await insertPendingJob(input, options);
  return {
    jobId: String(job._id),
    eventId: String(event._id),
  };
}

/**
 * Lists jobs for a project (caller already passed project ACL on the route).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ cursor?: string, limit?: unknown, jobStatus?: string }} [query] List query.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listProjectJobs(orgId, projectId, query = {}) {
  const result = await listJobsByProject(orgId, projectId, query);
  return {
    items: result.items.map(mapJobToListDto),
    pageInfo: result.pageInfo,
  };
}

/**
 * Loads a job by id with events after project ACL check.
 * Cross-tenant / no project access → JOB_NOT_FOUND (enumeration-safe).
 * @param {string} orgId Tenant id.
 * @param {string} userId Actor user id.
 * @param {string} jobId Job id.
 * @param {{ requestMemo?: Map<string, unknown> }} [options] Optional ACL request memo.
 * @returns {Promise<object>}
 */
export async function getJobById(orgId, userId, jobId, options = {}) {
  const job = await findJobById(orgId, jobId);
  if (!job) {
    throw ApiError.fromCode('JOB_NOT_FOUND');
  }

  const projectId = String(job.projectId);
  const resolved = await resolveProjectPermissions(orgId, userId, projectId, {
    requestMemo: options.requestMemo,
  });

  if (resolved.kind === 'NO_ACCESS') {
    throw ApiError.fromCode('JOB_NOT_FOUND');
  }

  if (!hasRequiredPermissions(resolved.permissions, ['projects.view'], 'all')) {
    throw ApiError.fromCode('FORBIDDEN');
  }

  const events = await listEventsForJob(orgId, jobId);
  return mapJobToDetailDto(job, events);
}

// --- from jobs/jobControl.service.js ---
/**
 * Job control service — user-initiated retry and cancel with ACL and audit.
 */
/**
 * Allowed next statuses for each current jobStatus.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const ALLOWED_JOB_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['running', 'cancelled']),
  running: Object.freeze([
    'completed',
    'completed_with_warnings',
    'failed',
    'cancelled',
    'pending',
  ]),
  failed: Object.freeze(['retrying']),
  retrying: Object.freeze(['pending', 'running', 'cancelled']),
  cancelled: Object.freeze(['retrying']),
  completed: Object.freeze([]),
  completed_with_warnings: Object.freeze([]),
});

/**
 * Returns whether `from` → `to` is an allowed jobStatus transition.
 * @param {string} from Current status.
 * @param {string} to Desired status.
 * @returns {boolean}
 */
export function isAllowedJobTransition(from, to) {
  const allowed = ALLOWED_JOB_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Asserts that a jobStatus transition is allowed.
 * @param {string} from Current status.
 * @param {string} to Desired status.
 * @throws {ApiError} INVALID_JOB_TRANSITION when the pair is not allowed.
 */
export function assertJobTransition(from, to) {
  if (isAllowedJobTransition(from, to)) {
    return;
  }
  throw ApiError.fromCode('INVALID_JOB_TRANSITION', {
    details: { currentStatus: from, attemptedStatus: to },
  });
}

/**
 * Loads a job and enforces knowledge.trigger on its project.
 * Cross-tenant / no access → JOB_NOT_FOUND (enumeration-safe).
 * @param {string} orgId Tenant id.
 * @param {string} userId Actor user id.
 * @param {string} jobId Job id.
 * @param {{ requestMemo?: Map<string, unknown> }} [options] Optional ACL memo.
 * @returns {Promise<import('mongoose').Document>}
 */
async function loadJobForControl(orgId, userId, jobId, options = {}) {
  const job = await findJobById(orgId, jobId);
  if (!job) {
    throw ApiError.fromCode('JOB_NOT_FOUND');
  }

  const projectId = String(job.projectId);
  const resolved = await resolveProjectPermissions(orgId, userId, projectId, {
    requestMemo: options.requestMemo,
  });

  if (resolved.kind === 'NO_ACCESS') {
    throw ApiError.fromCode('JOB_NOT_FOUND');
  }

  if (!hasRequiredPermissions(resolved.permissions, ['knowledge.trigger'], 'all')) {
    throw ApiError.fromCode('FORBIDDEN');
  }

  return job;
}

/**
 * Builds the retry/cancel control response body.
 * @param {import('mongoose').Document} job Job document.
 * @param {{
 *   alreadyActive?: boolean,
 *   retry?: { mode: string, fromStage: string | null, reason: string | null },
 *   cancellation?: { requested: boolean, requestedAt: string | null },
 * }} extra Extra fields.
 * @returns {object}
 */
function toControlResponse(job, extra = {}) {
  return {
    jobId: String(job._id),
    jobStatus: job.jobStatus,
    ...extra,
  };
}

/**
 * Retries a failed or cancelled job (same document; mode from stored failure).
 * @param {{
 *   orgId: string,
 *   userId: string,
 *   jobId: string,
 *   correlationId: string,
 *   ip?: string | null,
 *   userAgent?: string | null,
 *   log?: { error?: Function },
 *   requestMemo?: Map<string, unknown>,
 * }} input Retry inputs.
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
export async function retryJob(input) {
  const job = await loadJobForControl(input.orgId, input.userId, input.jobId, {
    requestMemo: input.requestMemo,
  });

  if (job.jobStatus === 'pending' || job.jobStatus === 'retrying' || job.jobStatus === 'running') {
    const resolved = resolveJobRetryMode(job);
    return {
      statusCode: 200,
      body: toControlResponse(job, {
        alreadyActive: true,
        retry: {
          mode: resolved.mode === 'not_retryable' ? 'resume' : resolved.mode,
          fromStage: resolved.fromStage,
          reason: resolved.reason,
        },
      }),
    };
  }

  const active = await findActiveJobForProject(input.orgId, job.projectId);
  if (active && String(active._id) !== String(job._id)) {
    const resolved = resolveJobRetryMode(active);
    return {
      statusCode: 200,
      body: toControlResponse(active, {
        alreadyActive: true,
        retry: {
          mode: resolved.mode === 'not_retryable' ? 'full' : resolved.mode,
          fromStage: resolved.fromStage,
          reason: resolved.reason,
        },
      }),
    };
  }

  const project = await findProjectById(input.orgId, String(job.projectId));
  if (!project) {
    throw ApiError.fromCode('JOB_NOT_FOUND');
  }

  assertJobTransition(job.jobStatus, 'retrying');

  if ((job.retryCount ?? 0) >= JOB_MAX_USER_RETRIES) {
    throw ApiError.fromCode('JOB_RETRY_LIMIT_EXCEEDED', {
      details: { retryCount: job.retryCount, max: JOB_MAX_USER_RETRIES },
    });
  }

  const resolved = resolveJobRetryMode(job);
  if (resolved.mode === 'not_retryable') {
    throw ApiError.fromCode('JOB_NOT_RETRYABLE', {
      message: resolved.reason ?? undefined,
      details: {
        failureClass: job.failureClass ?? null,
        failedStage: job.currentStage ?? null,
      },
    });
  }

  const updated = await beginUserRetry({
    orgId: input.orgId,
    jobId: String(job._id),
    actorUserId: input.userId,
    mode: resolved.mode,
    clearCheckpoint: resolved.mode === 'full',
  });
  if (!updated) {
    const fresh = await findJobById(input.orgId, input.jobId);
    if (
      fresh &&
      (fresh.jobStatus === 'pending' ||
        fresh.jobStatus === 'retrying' ||
        fresh.jobStatus === 'running')
    ) {
      return {
        statusCode: 200,
        body: toControlResponse(fresh, {
          alreadyActive: true,
          retry: {
            mode: resolved.mode,
            fromStage: resolved.fromStage,
            reason: resolved.reason,
          },
        }),
      };
    }
    throw ApiError.fromCode('INVALID_JOB_TRANSITION', {
      details: { currentStatus: fresh?.jobStatus ?? job.jobStatus, attemptedStatus: 'retrying' },
    });
  }

  const message = renderJobEventMessage('job.retry_requested', {
    jobType: updated.jobType,
    fromStage: resolved.fromStage,
  });
  await appendJobEvent({
    orgId: updated.orgId,
    projectId: updated.projectId,
    jobId: updated._id,
    eventCode: 'job.retry_requested',
    severity: 'info',
    message,
    data: {
      mode: resolved.mode,
      fromStage: resolved.fromStage,
    },
    correlationId: input.correlationId,
    createdBy: input.userId,
  });

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.userId,
      action: 'job.retry',
      resourceType: 'job',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        mode: resolved.mode,
        fromStage: resolved.fromStage,
        projectId: String(updated.projectId),
      },
    },
    { log: input.log },
  );

  return {
    statusCode: 202,
    body: toControlResponse(updated, {
      alreadyActive: false,
      retry: {
        mode: resolved.mode,
        fromStage: resolved.fromStage,
        reason: resolved.reason,
      },
    }),
  };
}

/**
 * Cancels a pending/retrying job immediately, or requests cancel for a running job.
 * @param {{
 *   orgId: string,
 *   userId: string,
 *   jobId: string,
 *   correlationId: string,
 *   ip?: string | null,
 *   userAgent?: string | null,
 *   log?: { error?: Function },
 *   requestMemo?: Map<string, unknown>,
 * }} input Cancel inputs.
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
export async function cancelJob(input) {
  const job = await loadJobForControl(input.orgId, input.userId, input.jobId, {
    requestMemo: input.requestMemo,
  });

  if (job.jobStatus === 'cancelled') {
    return {
      statusCode: 200,
      body: toControlResponse(job, {
        cancellation: {
          requested: Boolean(job.cancelRequestedAt),
          requestedAt:
            job.cancelRequestedAt instanceof Date
              ? job.cancelRequestedAt.toISOString()
              : job.cancelRequestedAt
                ? String(job.cancelRequestedAt)
                : null,
        },
      }),
    };
  }

  if (job.jobStatus === 'running' && job.cancelRequestedAt) {
    return {
      statusCode: 202,
      body: toControlResponse(job, {
        cancellation: {
          requested: true,
          requestedAt:
            job.cancelRequestedAt instanceof Date
              ? job.cancelRequestedAt.toISOString()
              : String(job.cancelRequestedAt),
        },
      }),
    };
  }

  if (job.jobStatus === 'pending' || job.jobStatus === 'retrying') {
    assertJobTransition(job.jobStatus, 'cancelled');
    const updated = await cancelQueuedJob({
      orgId: input.orgId,
      jobId: String(job._id),
      actorUserId: input.userId,
    });
    if (!updated) {
      const fresh = await findJobById(input.orgId, input.jobId);
      if (fresh?.jobStatus === 'cancelled') {
        return {
          statusCode: 200,
          body: toControlResponse(fresh, {
            cancellation: { requested: false, requestedAt: null },
          }),
        };
      }
      throw ApiError.fromCode('INVALID_JOB_TRANSITION', {
        details: {
          currentStatus: fresh?.jobStatus ?? job.jobStatus,
          attemptedStatus: 'cancelled',
        },
      });
    }

    await appendJobEvent({
      orgId: updated.orgId,
      projectId: updated.projectId,
      jobId: updated._id,
      eventCode: 'job.cancelled',
      severity: 'info',
      message: renderJobEventMessage('job.cancelled'),
      data: {},
      correlationId: input.correlationId,
      createdBy: input.userId,
    });

    await recordAuditEvent(
      {
        orgId: input.orgId,
        actorUserId: input.userId,
        action: 'job.cancel',
        resourceType: 'job',
        resourceId: String(updated._id),
        result: 'success',
        correlationId: input.correlationId,
        ip: input.ip,
        userAgent: input.userAgent,
        context: {
          mode: 'immediate',
          projectId: String(updated.projectId),
          previousStatus: job.jobStatus,
        },
      },
      { log: input.log },
    );

    return {
      statusCode: 200,
      body: toControlResponse(updated, {
        cancellation: { requested: false, requestedAt: null },
      }),
    };
  }

  if (job.jobStatus === 'running') {
    assertJobTransition(job.jobStatus, 'cancelled');
    const updated = await requestRunningJobCancel({
      orgId: input.orgId,
      jobId: String(job._id),
      actorUserId: input.userId,
    });
    if (!updated) {
      const fresh = await findJobById(input.orgId, input.jobId);
      if (fresh?.cancelRequestedAt) {
        return {
          statusCode: 202,
          body: toControlResponse(fresh, {
            cancellation: {
              requested: true,
              requestedAt:
                fresh.cancelRequestedAt instanceof Date
                  ? fresh.cancelRequestedAt.toISOString()
                  : String(fresh.cancelRequestedAt),
            },
          }),
        };
      }
      throw ApiError.fromCode('INVALID_JOB_TRANSITION', {
        details: {
          currentStatus: fresh?.jobStatus ?? job.jobStatus,
          attemptedStatus: 'cancelled',
        },
      });
    }

    await recordAuditEvent(
      {
        orgId: input.orgId,
        actorUserId: input.userId,
        action: 'job.cancel',
        resourceType: 'job',
        resourceId: String(updated._id),
        result: 'success',
        correlationId: input.correlationId,
        ip: input.ip,
        userAgent: input.userAgent,
        context: {
          mode: 'requested',
          projectId: String(updated.projectId),
        },
      },
      { log: input.log },
    );

    return {
      statusCode: 202,
      body: toControlResponse(updated, {
        cancellation: {
          requested: true,
          requestedAt:
            updated.cancelRequestedAt instanceof Date
              ? updated.cancelRequestedAt.toISOString()
              : String(updated.cancelRequestedAt),
        },
      }),
    };
  }

  assertJobTransition(job.jobStatus, 'cancelled');
  // Unreachable when assert throws; keeps TypeScript-less exhaustiveness clear.
  throw ApiError.fromCode('INVALID_JOB_TRANSITION', {
    details: { currentStatus: job.jobStatus, attemptedStatus: 'cancelled' },
  });
}

export {
  JOB_DEFAULT_MAX_ATTEMPTS,
  JOB_ENQUEUED_MESSAGE,
  JOB_EVENT_CODE_ENQUEUED,
  JOB_EVENT_MESSAGE_MAX_LENGTH,
  JOB_EVENT_SEVERITY_VALUES,
  JOB_LIST_PAGE_SIZE_DEFAULT,
  JOB_LIST_PAGE_SIZE_MAX,
  JOB_STATUS_VALUES,
  JOB_TYPE_VALUES,
  FAILURE_CLASS_VALUES,
  ACTIVE_JOB_STATUSES,
  JOB_CANCEL_GRACE_MS,
  JOB_MAX_USER_RETRIES,
  appendJobEvent,
  assertJobEventMessageLength,
  beginUserRetry,
  cancelQueuedJob,
  clampJobListLimit,
  deferRunningJob,
  findActiveJobForProject,
  findActiveJobForProjectByTypes,
  findActiveJobForSourceVersion,
  findJobById,
  insertPendingJob,
  isKnownJobStatus,
  listEventsForJob,
  listJobsByProject,
  promoteRetryingJobToPending,
  requestRunningJobCancel,
  INGEST_STAGE_DEFINITIONS,
  JOB_STAGE_CATALOG,
  labelForJobStage,
  listStagesForJobType,
  JOB_EVENT_MESSAGES,
  messageContainsAbsolutePath,
  messageContainsObjectIdShape,
  messageContainsRawErrorFragment,
  renderJobEventMessage,
  describeRetryAvailability,
  resolveJobRetryMode,
  deriveKnowledgeAvailability,
  projectJobProgress,
} from './jobs.helper.js';

export { Job } from '../../models/job.model.js';
export { JobEvent } from '../../models/jobEvent.model.js';
export const JOB_MODELS = Object.freeze([Job, JobEvent]);
