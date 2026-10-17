/**
 * Extra workerRuntime paths: temporary/permanent failure, cancel, warnings, unknown type.
 */
import mongoose from 'mongoose';
import { createJobFailureError } from '../../src/worker/jobFailure.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJobHandlersForTests, registerJobHandler } from '../../src/worker/schedule.js';

const claimNextJob = vi.fn();
const recordJobClaimedEvent = vi.fn();
const releaseJobOnShutdown = vi.fn();
const finishJobCompleted = vi.fn();
const finishJobFailed = vi.fn();
const finishJobCancelled = vi.fn();
const requeueJobTemporaryFailure = vi.fn();
const requeueJobProjectBusy = vi.fn();
const acquireProjectJobLock = vi.fn();
const releaseProjectJobLock = vi.fn();
const updateOneExec = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
const jobAggregate = vi.fn().mockResolvedValue([]);
const requeueJobInterrupted = vi.fn();
const failJobLeaseExpired = vi.fn();

vi.mock('../../src/models/job.model.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Job: {
      findById: () => ({
        select: () => ({
          lean: () => ({
            exec: async () => ({ cancelRequestedAt: null }),
          }),
        }),
      }),
      updateOne: () => ({ exec: updateOneExec }),
      aggregate: (...args) => jobAggregate(...args),
    },
  };
});

vi.mock('../../src/worker/jobState.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    claimNextJob: (...args) => claimNextJob(...args),
    recordJobClaimedEvent: (...args) => recordJobClaimedEvent(...args),
    releaseJobOnShutdown: (...args) => releaseJobOnShutdown(...args),
    finishJobCompleted: (...args) => finishJobCompleted(...args),
    finishJobFailed: (...args) => finishJobFailed(...args),
    finishJobCancelled: (...args) => finishJobCancelled(...args),
    requeueJobTemporaryFailure: (...args) => requeueJobTemporaryFailure(...args),
    requeueJobProjectBusy: (...args) => requeueJobProjectBusy(...args),
    requeueJobInterrupted: (...args) => requeueJobInterrupted(...args),
    failJobLeaseExpired: (...args) => failJobLeaseExpired(...args),
  };
});

vi.mock('../../src/worker/projectLock.js', () => ({
  acquireProjectJobLock: (...args) => acquireProjectJobLock(...args),
  releaseProjectJobLock: (...args) => releaseProjectJobLock(...args),
  refreshProjectJobLock: vi.fn(),
}));

function makeJobDoc(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId('665f1c9d4b2a8e0012a4f010'),
    orgId: new mongoose.Types.ObjectId('6650aa1b4b2a8e0012a4e010'),
    projectId: new mongoose.Types.ObjectId('6651bb2c4b2a8e0012a4e010'),
    jobType: 'worker_smoke_check',
    attempt: 1,
    maxAttempts: 5,
    currentStage: null,
    correlationId: null,
    stageCheckpoint: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

describe('workerRuntime failure and cancel paths', () => {
  beforeEach(() => {
    clearJobHandlersForTests();
    claimNextJob.mockReset();
    recordJobClaimedEvent.mockReset().mockResolvedValue(undefined);
    releaseJobOnShutdown.mockReset().mockResolvedValue({});
    finishJobCompleted.mockReset().mockResolvedValue({});
    finishJobFailed.mockReset().mockResolvedValue({});
    finishJobCancelled.mockReset().mockResolvedValue({});
    requeueJobTemporaryFailure.mockReset().mockResolvedValue({});
    requeueJobProjectBusy.mockReset().mockResolvedValue({});
    acquireProjectJobLock.mockReset().mockResolvedValue({ acquired: true });
    releaseProjectJobLock.mockReset().mockResolvedValue(true);
    updateOneExec.mockReset().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    jobAggregate.mockReset().mockResolvedValue([]);
    requeueJobInterrupted.mockReset().mockResolvedValue(null);
    failJobLeaseExpired.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    clearJobHandlersForTests();
  });

  it('requeues temporary failures and fails permanent ones', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');

    registerJobHandler({
      type: 'worker_smoke_check',
      exclusiveScope: 'none',
      run: async () => {
        throw createJobFailureError({
          failureClass: 'temporary',
          code: 'TEMP',
          message: 'try again',
        });
      },
    });
    claimNextJob.mockResolvedValueOnce(makeJobDoc()).mockResolvedValue(null);
    const runtime = startWorkerRuntime({
      workerId: 'w-temp',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(requeueJobTemporaryFailure).toHaveBeenCalled());
    await runtime.stop();

    clearJobHandlersForTests();
    registerJobHandler({
      type: 'worker_smoke_check',
      exclusiveScope: 'none',
      run: async () => {
        throw createJobFailureError({
          failureClass: 'permanent',
          code: 'PERM',
          message: 'stop',
        });
      },
    });
    claimNextJob.mockResolvedValueOnce(makeJobDoc()).mockResolvedValue(null);
    const runtime2 = startWorkerRuntime({
      workerId: 'w-perm',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(finishJobFailed).toHaveBeenCalled());
    await runtime2.stop();
  });

  it('cancels when cancelRequestedAt is already set on the claimed job', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');
    registerJobHandler({
      type: 'worker_smoke_check',
      exclusiveScope: 'none',
      run: async () => ({ result: 'completed' }),
    });
    claimNextJob.mockResolvedValueOnce(makeJobDoc({ cancelRequestedAt: new Date() })).mockResolvedValue(null);
    const runtime = startWorkerRuntime({
      workerId: 'w-cancel',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(finishJobCancelled).toHaveBeenCalled());
    await runtime.stop();
  });

  it('completes with warnings and requeues when project lock is busy', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');
    registerJobHandler({
      type: 'project_knowledge_build',
      exclusiveScope: 'project',
      run: async () => ({ result: 'completed_with_warnings', summary: { w: 1 } }),
    });
    acquireProjectJobLock.mockResolvedValueOnce({ acquired: false });
    claimNextJob.mockResolvedValueOnce(makeJobDoc({ jobType: 'project_knowledge_build' })).mockResolvedValue(null);
    const runtime = startWorkerRuntime({
      workerId: 'w-busy',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      projectBusyRetryMs: 100,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(requeueJobProjectBusy).toHaveBeenCalled());
    await runtime.stop();

    clearJobHandlersForTests();
    finishJobCompleted.mockClear();
    registerJobHandler({
      type: 'project_knowledge_build',
      exclusiveScope: 'project',
      run: async () => ({ result: 'completed_with_warnings', summary: { w: 1 } }),
    });
    acquireProjectJobLock.mockResolvedValue({ acquired: true });
    claimNextJob.mockResolvedValueOnce(makeJobDoc({ jobType: 'project_knowledge_build' })).mockResolvedValue(null);
    const runtime2 = startWorkerRuntime({
      workerId: 'w-warn',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(finishJobCompleted).toHaveBeenCalledWith(expect.objectContaining({ result: 'completed_with_warnings' })));
    await runtime2.stop();
  });

  it('aborts when heartbeat throws and releases on shutdown errors', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');
    let releaseHandler = () => undefined;
    const gate = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    registerJobHandler({
      type: 'worker_smoke_check',
      exclusiveScope: 'none',
      run: async () => {
        await gate;
        return { result: 'completed' };
      },
    });
    claimNextJob.mockResolvedValueOnce(makeJobDoc()).mockResolvedValue(null);
    updateOneExec.mockRejectedValueOnce(new Error('hb down'));
    releaseJobOnShutdown.mockRejectedValueOnce(new Error('release fail'));
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = startWorkerRuntime({
      workerId: 'w-hb-err',
      log,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(runtime.getInFlightCount()).toBe(1));
    await runtime.heartbeatOnceForTests();
    expect(log.error).toHaveBeenCalled();
    await runtime.stop();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ jobId: expect.any(String) }), 'failed to release job on shutdown');
    releaseHandler();
  });

  it('fails user_action_required and logs unclassified errors', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');
    registerJobHandler({
      type: 'worker_smoke_check',
      exclusiveScope: 'none',
      run: async () => {
        throw createJobFailureError({
          failureClass: 'user_action_required',
          code: 'FIX_ME',
          message: 'fix input',
        });
      },
    });
    claimNextJob.mockResolvedValueOnce(makeJobDoc()).mockResolvedValue(null);
    const runtime = startWorkerRuntime({
      workerId: 'w-uar',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(finishJobFailed).toHaveBeenCalled());
    await runtime.stop();

    clearJobHandlersForTests();
    finishJobFailed.mockClear();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerJobHandler({
      type: 'worker_smoke_check',
      exclusiveScope: 'none',
      run: async () => {
        throw new Error('mystery');
      },
    });
    claimNextJob.mockResolvedValueOnce(makeJobDoc()).mockResolvedValue(null);
    const runtime2 = startWorkerRuntime({
      workerId: 'w-unclass',
      log,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(requeueJobTemporaryFailure).toHaveBeenCalled());
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ handler: 'worker_smoke_check' }),
      'unclassified handler error treated as temporary',
    );
    await runtime2.stop();
  });

  it('survives poll errors and runs the sweeper helper', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');
    registerJobHandler({
      type: 'worker_smoke_check',
      exclusiveScope: 'none',
      run: async () => ({ result: 'completed' }),
    });
    claimNextJob.mockRejectedValueOnce(new Error('mongo down')).mockResolvedValue(null);
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const timers = [];
    const runtime = startWorkerRuntime({
      workerId: 'w-err',
      log,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      setInterval: (_fn) => {
        const handle = { unref: vi.fn() };
        timers.push(handle);
        return handle;
      },
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(log.error).toHaveBeenCalled());
    expect(timers[0].unref).toHaveBeenCalled();
    jobAggregate.mockResolvedValueOnce([
      {
        _id: '665f1c9d4b2a8e0012a4f099',
        orgId: '6650aa1b4b2a8e0012a4e099',
        projectId: '6651bb2c4b2a8e0012a4e099',
        attempt: 1,
        maxAttempts: 5,
      },
    ]);
    requeueJobInterrupted.mockResolvedValueOnce({
      _id: '665f1c9d4b2a8e0012a4f099',
      orgId: '6650aa1b4b2a8e0012a4e099',
      projectId: '6651bb2c4b2a8e0012a4e099',
      attempt: 1,
    });
    await expect(runtime.sweepOnceForTests()).resolves.toEqual({ requeued: 1, failed: 0 });
    jobAggregate.mockRejectedValueOnce(new Error('sweep fail'));
    await expect(runtime.sweepOnceForTests()).resolves.toEqual({ requeued: 0, failed: 0 });
    await runtime.stop();
  });
});
