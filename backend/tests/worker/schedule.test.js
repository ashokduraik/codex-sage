/**
 * Unit tests for schedule enqueue ticks (poll/claim mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/modules/knowledge/index.js', () => ({
  enqueueDueRepositorySyncs: vi.fn(),
  REPO_SYNC_SCHEDULER_TICK_MS: 60_000,
}));

vi.mock('../../src/modules/masters/index.js', () => ({
  appendJobEvent: vi.fn(),
  findProjectById: vi.fn().mockResolvedValue(null),
  findOrganizationById: vi.fn().mockResolvedValue(null),
  emitNotificationsForJobTerminal: vi.fn(),
  recordProjectActivitiesForJobTerminal: vi.fn(),
}));

vi.mock('../../src/modules/conversation/index.js', () => ({
  sweepExpiredQueuedMessages: vi.fn(),
  QUEUED_MESSAGE_SWEEP_INTERVAL_MS: 60_000,
}));

vi.mock('../../src/worker/agedOrgDataCleanupJob.js', () => ({
  enqueueDueAgedOrgDataCleanupJobs: vi.fn(),
  AGED_ORG_DATA_CLEANUP_SCHEDULER_TICK_MS: 3_600_000,
}));

vi.mock('../../src/worker/jobState.js', () => ({
  claimNextJob: vi.fn().mockResolvedValue(null),
  finishJobFailed: vi.fn(),
  saveJobProgress: vi.fn(),
  resolveNextDueAt: vi.fn(),
  saveJobCheckpoint: vi.fn(),
  finishJobCancelled: vi.fn(),
  finishJobCompleted: vi.fn(),
  releaseJobOnShutdown: vi.fn(),
  recordJobClaimedEvent: vi.fn(),
  requeueJobProjectBusy: vi.fn(),
  requeueJobTemporaryFailure: vi.fn(),
  failJobLeaseExpired: vi.fn(),
  requeueJobInterrupted: vi.fn(),
}));

import { startSchedule } from '../../src/worker/schedule.js';
import { enqueueDueRepositorySyncs } from '../../src/modules/knowledge/index.js';
import { sweepExpiredQueuedMessages } from '../../src/modules/conversation/index.js';
import { enqueueDueAgedOrgDataCleanupJobs } from '../../src/worker/agedOrgDataCleanupJob.js';

describe('startSchedule enqueue ticks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueDueRepositorySyncs.mockResolvedValue({ enqueued: 0, skipped: 0 });
    enqueueDueAgedOrgDataCleanupJobs.mockResolvedValue({ enqueued: 0, skipped: 0 });
    sweepExpiredQueuedMessages.mockResolvedValue({ expired: 0 });
  });

  it('runs each enqueue tick immediately when enableEnqueueTicks is true', async () => {
    const setIntervalFn = vi.fn(() => 1);
    const clearIntervalFn = vi.fn();
    const log = { error: vi.fn(), info: vi.fn() };

    const handle = startSchedule({
      workerId: 'w1',
      log,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
      enableEnqueueTicks: true,
    });

    expect(enqueueDueRepositorySyncs).toHaveBeenCalledWith({ log });
    expect(enqueueDueAgedOrgDataCleanupJobs).toHaveBeenCalledWith({ log });
    expect(sweepExpiredQueuedMessages).toHaveBeenCalledWith({ log });
    // poll + heartbeat + sweep + 3 enqueue timers
    expect(setIntervalFn.mock.calls.length).toBeGreaterThanOrEqual(6);
    await handle.stop();
    expect(clearIntervalFn).toHaveBeenCalled();
  });

  it('logs and continues when an enqueue tick rejects', async () => {
    const log = { error: vi.fn(), info: vi.fn() };
    enqueueDueRepositorySyncs.mockRejectedValueOnce(new Error('enqueue boom'));

    const handle = startSchedule({
      workerId: 'w1',
      log,
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      enableEnqueueTicks: true,
    });

    await vi.waitFor(() => {
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ errMessage: 'enqueue boom' }), 'connected_repo_pull enqueue tick failed');
    });
    await handle.stop();
  });

  it('uses injected enqueue seams when provided', async () => {
    const enqueueDueRepositorySyncsLocal = vi.fn().mockResolvedValue({ enqueued: 1, skipped: 0 });
    const enqueueDueAgedOrgDataCleanupJobsLocal = vi.fn().mockResolvedValue({ enqueued: 0, skipped: 1 });
    const sweepExpiredQueuedMessagesLocal = vi.fn().mockResolvedValue({ expired: 2 });
    const log = { error: vi.fn(), info: vi.fn() };

    const handle = startSchedule({
      workerId: 'w1',
      log,
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      enableEnqueueTicks: true,
      enqueueDueRepositorySyncs: enqueueDueRepositorySyncsLocal,
      enqueueDueAgedOrgDataCleanupJobs: enqueueDueAgedOrgDataCleanupJobsLocal,
      sweepExpiredQueuedMessages: sweepExpiredQueuedMessagesLocal,
    });

    expect(enqueueDueRepositorySyncsLocal).toHaveBeenCalledWith({ log });
    expect(enqueueDueAgedOrgDataCleanupJobsLocal).toHaveBeenCalledWith({ log });
    expect(sweepExpiredQueuedMessagesLocal).toHaveBeenCalledWith({ log });
    expect(enqueueDueRepositorySyncs).not.toHaveBeenCalled();
    await handle.stop();
  });
});
