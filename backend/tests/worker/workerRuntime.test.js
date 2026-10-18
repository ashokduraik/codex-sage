/**
 * Unit tests for workerRuntime concurrency gate and shutdown release (mocked claim layer).
 */
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJobHandlersForTests, registerJobHandler } from '../../src/worker/schedule.js';

const claimNextJob = vi.fn();
const recordJobClaimedEvent = vi.fn();
const releaseJobOnShutdown = vi.fn();
const finishJobCompleted = vi.fn();
const requeueJobProjectBusy = vi.fn();
const acquireProjectJobLock = vi.fn();
const releaseProjectJobLock = vi.fn();

const updateOneExec = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

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
      aggregate: vi.fn().mockResolvedValue([]),
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
    requeueJobProjectBusy: (...args) => requeueJobProjectBusy(...args),
    finishJobFailed: vi.fn().mockResolvedValue({}),
    requeueJobTemporaryFailure: vi.fn().mockResolvedValue({}),
    finishJobCancelled: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('../../src/worker/projectLock.js', () => ({
  acquireProjectJobLock: (...args) => acquireProjectJobLock(...args),
  releaseProjectJobLock: (...args) => releaseProjectJobLock(...args),
  refreshProjectJobLock: vi.fn(),
}));

vi.mock('../../src/modules/masters/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findOrganizationById: vi.fn().mockResolvedValue({ name: 'Test Org' }),
    findProjectById: vi.fn().mockResolvedValue({ name: 'Test Project' }),
  };
});

function makeJobDoc(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId('665f1c9d4b2a8e0012a4f001'),
    orgId: new mongoose.Types.ObjectId('6650aa1b4b2a8e0012a4e001'),
    projectId: new mongoose.Types.ObjectId('6651bb2c4b2a8e0012a4e002'),
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

describe('workerRuntime', () => {
  beforeEach(() => {
    clearJobHandlersForTests();
    claimNextJob.mockReset();
    recordJobClaimedEvent.mockReset().mockResolvedValue(undefined);
    releaseJobOnShutdown.mockReset().mockResolvedValue({});
    finishJobCompleted.mockReset().mockResolvedValue({});
    requeueJobProjectBusy.mockReset().mockResolvedValue({});
    acquireProjectJobLock.mockReset();
    releaseProjectJobLock.mockReset().mockResolvedValue(true);
    updateOneExec.mockReset().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  afterEach(() => {
    clearJobHandlersForTests();
  });

  it('stops claiming at max concurrent jobs while a slot is full', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');
    let releaseHandler = () => undefined;
    const handlerGate = new Promise((resolve) => {
      releaseHandler = resolve;
    });

    registerJobHandler({
      type: 'worker_smoke_check',
      exclusiveScope: 'none',
      run: async () => {
        await handlerGate;
        return { result: 'completed' };
      },
    });

    claimNextJob.mockResolvedValueOnce(makeJobDoc()).mockResolvedValue(null);

    const runtime = startWorkerRuntime({
      workerId: 'w-1',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxConcurrentJobs: 1,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 5,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });

    await vi.waitFor(() => expect(runtime.getInFlightCount()).toBe(1));
    const callsAtCapacity = claimNextJob.mock.calls.length;
    await runtime.claimOnceForTests();
    expect(claimNextJob.mock.calls.length).toBe(callsAtCapacity);

    releaseHandler();
    await runtime.stop();
  });

  it('shutdown returns an in-flight job to pending and releases its lock', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');
    let releaseHandler = () => undefined;
    const handlerGate = new Promise((resolve) => {
      releaseHandler = resolve;
    });

    registerJobHandler({
      type: 'project_knowledge_build',
      exclusiveScope: 'project',
      run: async () => {
        await handlerGate;
        return { result: 'completed' };
      },
    });

    acquireProjectJobLock.mockResolvedValue({ acquired: true });

    const jobDoc = makeJobDoc({
      _id: new mongoose.Types.ObjectId('665f1c9d4b2a8e0012a4f002'),
      jobType: 'project_knowledge_build',
    });
    claimNextJob.mockResolvedValueOnce(jobDoc).mockResolvedValue(null);

    const runtime = startWorkerRuntime({
      workerId: 'w-shutdown',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxConcurrentJobs: 2,
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      drainTimeoutMs: 10,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });

    await vi.waitFor(() => expect(runtime.getInFlightCount()).toBeGreaterThan(0));
    await runtime.stop();
    expect(releaseJobOnShutdown).toHaveBeenCalledWith({
      jobId: String(jobDoc._id),
      workerId: 'w-shutdown',
    });
    expect(releaseProjectJobLock).toHaveBeenCalled();
    releaseHandler();
  });

  it('aborts the job signal when heartbeat reports lost ownership', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');
    /** @type {AbortSignal | undefined} */
    let seenSignal;
    let releaseHandler = () => undefined;
    const handlerGate = new Promise((resolve) => {
      releaseHandler = resolve;
    });

    registerJobHandler({
      type: 'worker_smoke_check',
      exclusiveScope: 'none',
      run: async (ctx) => {
        seenSignal = ctx.signal;
        await handlerGate;
        return { result: 'completed' };
      },
    });

    claimNextJob.mockResolvedValueOnce(makeJobDoc()).mockResolvedValue(null);
    updateOneExec.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    const runtime = startWorkerRuntime({
      workerId: 'w-hb',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });

    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    await runtime.heartbeatOnceForTests();
    expect(seenSignal?.aborted).toBe(true);
    releaseHandler();
    await runtime.stop();
  });

  it('does not complete a job when the handler returns deferred', async () => {
    const { startWorkerRuntime } = await import('../../src/worker/schedule.js');
    registerJobHandler({
      type: 'connected_repo_pull',
      exclusiveScope: 'none',
      run: async () => ({ result: 'deferred' }),
    });
    claimNextJob.mockResolvedValueOnce(makeJobDoc({ jobType: 'connected_repo_pull' })).mockResolvedValue(null);
    const runtime = startWorkerRuntime({
      workerId: 'w-defer',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    await vi.waitFor(() => expect(claimNextJob).toHaveBeenCalled());
    await vi.waitFor(() => expect(runtime.getInFlightCount()).toBe(0));
    expect(finishJobCompleted).not.toHaveBeenCalled();
    await runtime.stop();
  });
});
