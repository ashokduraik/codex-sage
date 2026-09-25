/**
 * Unit tests for job control service (retry/cancel).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';

const {
  hasRequiredPermissions,
  resolveProjectPermissions,
  findProjectById,
  recordAuditEvent,
} = vi.hoisted(() => ({
  hasRequiredPermissions: vi.fn(),
  resolveProjectPermissions: vi.fn(),
  findProjectById: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock('../../../src/modules/access/permissions.js', () => ({
  hasRequiredPermissions,
}));
vi.mock('../../../src/modules/masters/projectMembers.js', () => ({
  resolveProjectPermissions,
}));
vi.mock('../../../src/modules/masters/projects.js', () => ({
  findProjectById,
}));
vi.mock('../../../src/modules/access/index.js', () => ({
  hasRequiredPermissions,
  recordAuditEvent,
}));
vi.mock('../../../src/modules/masters/jobs.helper.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findJobById: vi.fn(),
    findActiveJobForProject: vi.fn(),
    beginUserRetry: vi.fn(),
    cancelQueuedJob: vi.fn(),
    requestRunningJobCancel: vi.fn(),
    appendJobEvent: vi.fn(),
  };
});

import {
  appendJobEvent,
  beginUserRetry,
  cancelQueuedJob,
  findActiveJobForProject,
  findJobById,
  requestRunningJobCancel,
} from '../../../src/modules/masters/jobs.helper.js';
import { cancelJob, retryJob } from '../../../src/modules/masters/jobs.js';

const orgId = '665f1c9d4b2a8e0012a4f010';
const userId = '665f1c9d4b2a8e0012a4f011';
const projectId = '665f1c9d4b2a8e0012a4f012';
const jobId = '665f1c9d4b2a8e0012a4f001';

/**
 * @param {object} overrides Job field overrides.
 * @returns {object}
 */
function makeJob(overrides = {}) {
  return {
    _id: jobId,
    orgId,
    projectId,
    jobType: 'ingest',
    jobStatus: 'failed',
    failureClass: 'temporary',
    currentStage: 'materialize_docs',
    stageCheckpoint: { lastCompletedStage: 'exclude_apply' },
    retryCount: 0,
    cancelRequestedAt: null,
    ...overrides,
  };
}

describe('jobControl.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveProjectPermissions.mockResolvedValue({
      kind: 'OK',
      permissions: new Set(['knowledge.trigger']),
    });
    hasRequiredPermissions.mockReturnValue(true);
    findProjectById.mockResolvedValue({ _id: projectId });
    findActiveJobForProject.mockResolvedValue(null);
    appendJobEvent.mockResolvedValue({});
    recordAuditEvent.mockResolvedValue(undefined);
  });

  it('retries a failed job with resume mode and audits', async () => {
    findJobById.mockResolvedValue(makeJob());
    beginUserRetry.mockResolvedValue(makeJob({ jobStatus: 'retrying', lastRetryMode: 'resume' }));

    const result = await retryJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_retry_1',
    });

    expect(result.statusCode).toBe(202);
    expect(result.body.jobStatus).toBe('retrying');
    expect(result.body.retry.mode).toBe('resume');
    expect(beginUserRetry).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'resume', clearCheckpoint: false }),
    );
    expect(appendJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'job.retry_requested' }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job.retry', result: 'success' }),
      expect.any(Object),
    );
  });

  it('returns alreadyActive when the job is already running', async () => {
    findJobById.mockResolvedValue(makeJob({ jobStatus: 'running' }));
    const result = await retryJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_retry_2',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.alreadyActive).toBe(true);
    expect(beginUserRetry).not.toHaveBeenCalled();
  });

  it('rejects not_retryable upload failures', async () => {
    findJobById.mockResolvedValue(
      makeJob({
        failureClass: 'user_action_required',
        currentStage: 'validate_upload',
        stageCheckpoint: null,
      }),
    );
    await expect(
      retryJob({ orgId, userId, jobId, correlationId: 'req_retry_3' }),
    ).rejects.toMatchObject({ code: 'JOB_NOT_RETRYABLE' });
  });

  it('rejects retry on completed jobs', async () => {
    findJobById.mockResolvedValue(makeJob({ jobStatus: 'completed' }));
    await expect(
      retryJob({ orgId, userId, jobId, correlationId: 'req_retry_4' }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_TRANSITION' });
  });

  it('cancels a pending job immediately', async () => {
    findJobById.mockResolvedValue(makeJob({ jobStatus: 'pending' }));
    cancelQueuedJob.mockResolvedValue(makeJob({ jobStatus: 'cancelled' }));

    const result = await cancelJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_cancel_1',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.jobStatus).toBe('cancelled');
    expect(cancelQueuedJob).toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job.cancel' }),
      expect.any(Object),
    );
  });

  it('requests cancel on a running job without marking it cancelled yet', async () => {
    const requestedAt = new Date('2026-09-11T10:44:01.000Z');
    findJobById.mockResolvedValue(makeJob({ jobStatus: 'running' }));
    requestRunningJobCancel.mockResolvedValue(
      makeJob({ jobStatus: 'running', cancelRequestedAt: requestedAt }),
    );

    const result = await cancelJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_cancel_2',
    });
    expect(result.statusCode).toBe(202);
    expect(result.body.jobStatus).toBe('running');
    expect(result.body.cancellation).toEqual({
      requested: true,
      requestedAt: requestedAt.toISOString(),
    });
  });

  it('returns 200 for an already-cancelled job', async () => {
    findJobById.mockResolvedValue(makeJob({ jobStatus: 'cancelled' }));
    const result = await cancelJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_cancel_3',
    });
    expect(result.statusCode).toBe(200);
    expect(cancelQueuedJob).not.toHaveBeenCalled();
  });

  it('maps missing jobs and forbidden callers', async () => {
    findJobById.mockResolvedValue(null);
    await expect(
      retryJob({ orgId, userId, jobId, correlationId: 'req_x' }),
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });

    findJobById.mockResolvedValue(makeJob());
    hasRequiredPermissions.mockReturnValue(false);
    await expect(
      cancelJob({ orgId, userId, jobId, correlationId: 'req_y' }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('returns alreadyActive when another project job is active', async () => {
    findJobById.mockResolvedValue(makeJob());
    findActiveJobForProject.mockResolvedValue(
      makeJob({ _id: '665f1c9d4b2a8e0012a4f099', jobStatus: 'running' }),
    );
    const result = await retryJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_retry_other',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.jobId).toBe('665f1c9d4b2a8e0012a4f099');
    expect(result.body.alreadyActive).toBe(true);
  });

  it('rejects soft-deleted projects and retry ceiling', async () => {
    findJobById.mockResolvedValue(makeJob());
    findProjectById.mockResolvedValue(null);
    await expect(
      retryJob({ orgId, userId, jobId, correlationId: 'req_retry_del' }),
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });

    findProjectById.mockResolvedValue({ _id: projectId });
    findJobById.mockResolvedValue(makeJob({ retryCount: 10 }));
    await expect(
      retryJob({ orgId, userId, jobId, correlationId: 'req_retry_max' }),
    ).rejects.toMatchObject({ code: 'JOB_RETRY_LIMIT_EXCEEDED' });
  });

  it('full-mode retry clears the checkpoint', async () => {
    findJobById.mockResolvedValue(
      makeJob({
        failureClass: 'temporary',
        currentStage: 'codegraph_update',
        stageCheckpoint: { lastCompletedStage: 'materialize_docs' },
      }),
    );
    beginUserRetry.mockResolvedValue(
      makeJob({ jobStatus: 'retrying', lastRetryMode: 'full', stageCheckpoint: null }),
    );
    const result = await retryJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_retry_full',
    });
    expect(result.statusCode).toBe(202);
    expect(result.body.retry.mode).toBe('full');
    expect(beginUserRetry).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'full', clearCheckpoint: true }),
    );
  });

  it('handles beginUserRetry races', async () => {
    findJobById
      .mockResolvedValueOnce(makeJob())
      .mockResolvedValueOnce(makeJob({ jobStatus: 'retrying' }));
    beginUserRetry.mockResolvedValue(null);
    const raced = await retryJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_retry_race',
    });
    expect(raced.statusCode).toBe(200);
    expect(raced.body.alreadyActive).toBe(true);

    findJobById
      .mockResolvedValueOnce(makeJob())
      .mockResolvedValueOnce(makeJob({ jobStatus: 'completed' }));
    beginUserRetry.mockResolvedValue(null);
    await expect(
      retryJob({ orgId, userId, jobId, correlationId: 'req_retry_race2' }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_TRANSITION' });
  });

  it('handles cancel races and duplicate running cancel requests', async () => {
    const requestedAt = new Date('2026-09-11T10:44:01.000Z');
    findJobById.mockResolvedValue(
      makeJob({ jobStatus: 'running', cancelRequestedAt: requestedAt }),
    );
    const dup = await cancelJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_cancel_dup',
    });
    expect(dup.statusCode).toBe(202);
    expect(dup.body.cancellation.requested).toBe(true);

    findJobById
      .mockResolvedValueOnce(makeJob({ jobStatus: 'pending' }))
      .mockResolvedValueOnce(makeJob({ jobStatus: 'cancelled' }));
    cancelQueuedJob.mockResolvedValue(null);
    const racedPending = await cancelJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_cancel_race',
    });
    expect(racedPending.statusCode).toBe(200);

    findJobById
      .mockResolvedValueOnce(makeJob({ jobStatus: 'pending' }))
      .mockResolvedValueOnce(makeJob({ jobStatus: 'running' }));
    cancelQueuedJob.mockResolvedValue(null);
    await expect(
      cancelJob({ orgId, userId, jobId, correlationId: 'req_cancel_race2' }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_TRANSITION' });

    findJobById
      .mockResolvedValueOnce(makeJob({ jobStatus: 'running', cancelRequestedAt: null }))
      .mockResolvedValueOnce(
        makeJob({ jobStatus: 'running', cancelRequestedAt: '2026-09-11T10:44:01.000Z' }),
      );
    requestRunningJobCancel.mockResolvedValue(null);
    const racedRunning = await cancelJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_cancel_race3',
    });
    expect(racedRunning.statusCode).toBe(202);

    findJobById
      .mockResolvedValueOnce(makeJob({ jobStatus: 'running', cancelRequestedAt: null }))
      .mockResolvedValueOnce(makeJob({ jobStatus: 'failed', cancelRequestedAt: null }));
    requestRunningJobCancel.mockResolvedValue(null);
    await expect(
      cancelJob({ orgId, userId, jobId, correlationId: 'req_cancel_race4' }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_TRANSITION' });
  });

  it('cancels a retrying job and rejects cancel on completed', async () => {
    findJobById.mockResolvedValue(makeJob({ jobStatus: 'retrying' }));
    cancelQueuedJob.mockResolvedValue(makeJob({ jobStatus: 'cancelled' }));
    const result = await cancelJob({
      orgId,
      userId,
      jobId,
      correlationId: 'req_cancel_retrying',
    });
    expect(result.statusCode).toBe(200);

    findJobById.mockResolvedValue(makeJob({ jobStatus: 'completed' }));
    await expect(
      cancelJob({ orgId, userId, jobId, correlationId: 'req_cancel_done' }),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_TRANSITION' });
  });

  it('returns 404 when project ACL is NO_ACCESS', async () => {
    findJobById.mockResolvedValue(makeJob());
    resolveProjectPermissions.mockResolvedValue({ kind: 'NO_ACCESS', permissions: new Set() });
    await expect(
      retryJob({ orgId, userId, jobId, correlationId: 'req_no_access' }),
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});
