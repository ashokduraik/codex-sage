/**
 * Job control service — user-initiated retry and cancel with ACL and audit.
 */
import { ApiError } from '../../platform/errors.js';
import { hasRequiredPermissions } from '../authorization/permissionResolver.js';
import { resolveProjectPermissions } from '../projectMembers/projectAccess.js';
import { findProjectById } from '../projects/index.js';
import { recordAuditEvent } from '../audit/index.js';
import { JOB_MAX_USER_RETRIES } from './jobControl.constants.js';
import { assertJobTransition } from './jobTransitions.js';
import { renderJobEventMessage } from './jobEventCatalog.js';
import { resolveJobRetryMode } from './jobRetryMode.js';
import {
  appendJobEvent,
  beginUserRetry,
  cancelQueuedJob,
  findActiveJobForProject,
  findJobById,
  requestRunningJobCancel,
} from './jobs.repository.js';

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
