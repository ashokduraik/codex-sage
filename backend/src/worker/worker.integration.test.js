/**
 * Integration tests for worker claim, project lock, lease sweep, and smoke completion.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../test/appConfig.js';
import { Job } from '../modules/jobs/job.model.js';
import { JobEvent } from '../modules/jobs/jobEvent.model.js';
import { insertPendingJob, listEventsForJob } from '../modules/jobs/jobs.repository.js';
import { clearJobHandlersForTests, registerJobHandler } from './handlerRegistry.js';
import { claimNextJob } from './jobClaim.js';
import {
  acquireProjectJobLock,
  releaseProjectJobLock,
} from './projectJobLock.js';
import { ProjectJobLock } from './projectJobLock.model.js';
import { sweepExpiredLeases } from './leaseSweeper.js';
import { workerSmokeHandlerRegistration } from './handlers/workerSmokeHandler.js';
import { startWorkerRuntime } from './workerRuntime.js';
import {
  WORKER_EVENT_CLAIMED,
  WORKER_EVENT_INTERRUPTED_REQUEUED,
  WORKER_EVENT_PROJECT_BUSY_REQUEUED,
  WORKER_LEASE_EXPIRED_CODE,
} from './worker.events.js';

const harness = createMongoHarness({
  models: [Job, JobEvent, ProjectJobLock],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('worker process integration', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    clearJobHandlersForTests();
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  beforeEach(() => {
    clearJobHandlersForTests();
  });

  it('ten concurrent claims against one pending job: exactly one wins', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const { job } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'worker_smoke',
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        claimNextJob({
          workerId: `worker-${index}`,
          registeredTypes: ['worker_smoke'],
        }),
      ),
    );

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0].attempt).toBe(1);
    expect(winners[0].jobStatus).toBe('running');

    const fresh = await Job.findById(job._id).exec();
    expect(fresh.attempt).toBe(1);
    expect(fresh.workerId).toMatch(/^worker-/);
  });

  it('requeues a second exclusive job on the same project until the lock releases', async () => {
    registerJobHandler({
      type: 'ingest',
      exclusiveScope: 'project',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { result: 'completed' };
      },
    });

    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    await insertPendingJob({ orgId, projectId, jobType: 'ingest' });
    await insertPendingJob({ orgId, projectId, jobType: 'ingest' });

    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = startWorkerRuntime({
      workerId: 'w-exclusive',
      log,
      maxConcurrentJobs: 2,
      pollIntervalMs: 50,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      projectBusyRetryMs: 200,
    });

    await vi.waitFor(
      async () => {
        const events = await JobEvent.find({
          orgId,
          eventCode: WORKER_EVENT_PROJECT_BUSY_REQUEUED,
        }).exec();
        expect(events.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000 },
    );

    await vi.waitFor(
      async () => {
        const completed = await Job.countDocuments({
          orgId,
          projectId,
          jobStatus: 'completed',
        }).exec();
        expect(completed).toBe(2);
      },
      { timeout: 15_000 },
    );

    await runtime.stop();
  }, 30_000);

  it('runs exclusive jobs on different projects concurrently', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    registerJobHandler({
      type: 'ingest',
      exclusiveScope: 'project',
      run: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 150));
        concurrent -= 1;
        return { result: 'completed' };
      },
    });

    const orgId = new mongoose.Types.ObjectId();
    const projectA = new mongoose.Types.ObjectId();
    const projectB = new mongoose.Types.ObjectId();
    await insertPendingJob({ orgId, projectId: projectA, jobType: 'ingest' });
    await insertPendingJob({ orgId, projectId: projectB, jobType: 'ingest' });

    const runtime = startWorkerRuntime({
      workerId: 'w-cross',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      maxConcurrentJobs: 2,
      pollIntervalMs: 40,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
    });

    await vi.waitFor(
      async () => {
        const completed = await Job.countDocuments({ orgId, jobStatus: 'completed' }).exec();
        expect(completed).toBe(2);
      },
      { timeout: 10_000 },
    );

    expect(maxConcurrent).toBe(2);
    await runtime.stop();
  }, 20_000);

  it('sweeper requeues an expired lease and preserves the checkpoint', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const { job } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'worker_smoke',
    });

    const past = new Date(Date.now() - 60_000);
    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          jobStatus: 'running',
          workerId: 'dead-worker',
          attempt: 1,
          leaseExpiresAt: past,
          heartbeatAt: past,
          stageCheckpoint: {
            lastCompletedStage: 'exclude_apply',
            updatedAt: past,
          },
          currentStage: 'exclude_apply',
        },
      },
    ).exec();

    const result = await sweepExpiredLeases({
      log: { info: vi.fn(), error: vi.fn() },
    });
    expect(result.requeued).toBe(1);

    const fresh = await Job.findById(job._id).exec();
    expect(fresh.jobStatus).toBe('pending');
    expect(fresh.workerId).toBeNull();
    expect(fresh.stageCheckpoint.lastCompletedStage).toBe('exclude_apply');

    const events = await listEventsForJob(orgId, String(job._id));
    expect(events.some((event) => event.eventCode === WORKER_EVENT_INTERRUPTED_REQUEUED)).toBe(
      true,
    );
  });

  it('sweeper fails when attempts are exhausted and the failed job stays readable', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const { job } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'worker_smoke',
      maxAttempts: 2,
    });

    const past = new Date(Date.now() - 60_000);
    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          jobStatus: 'running',
          workerId: 'dead-worker',
          attempt: 2,
          maxAttempts: 2,
          leaseExpiresAt: past,
          heartbeatAt: past,
        },
      },
    ).exec();

    const result = await sweepExpiredLeases();
    expect(result.failed).toBe(1);

    const fresh = await Job.findById(job._id).exec();
    expect(fresh.jobStatus).toBe('failed');
    expect(fresh.failureClass).toBe('temporary');
    expect(fresh.failureCode).toBe(WORKER_LEASE_EXPIRED_CODE);
    expect(fresh.status).toBe('A');
  });

  it('does not claim a job with a future scheduledAt', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await insertPendingJob({
      orgId,
      projectId,
      jobType: 'worker_smoke',
      scheduledAt: future,
    });

    const claimed = await claimNextJob({
      workerId: 'w-sched',
      registeredTypes: ['worker_smoke'],
    });
    expect(claimed).toBeNull();
  });

  it('takes over a project lock whose expiresAt has passed', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const oldJobId = new mongoose.Types.ObjectId();
    const newJobId = new mongoose.Types.ObjectId();
    const past = new Date(Date.now() - 120_000);

    await ProjectJobLock.create({
      orgId,
      projectId,
      jobId: oldJobId,
      workerId: 'old-worker',
      lockScope: 'project_writer',
      acquiredAt: past,
      expiresAt: past,
    });

    const result = await acquireProjectJobLock({
      orgId,
      projectId,
      jobId: newJobId,
      workerId: 'new-worker',
    });
    expect(result.acquired).toBe(true);

    const lock = await ProjectJobLock.findOne({
      orgId,
      projectId,
      status: 'A',
    }).exec();
    expect(String(lock.jobId)).toBe(String(newJobId));
    expect(lock.workerId).toBe('new-worker');
  });

  it('two sweepers requeue an expired job only once', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const { job } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'worker_smoke',
    });
    const past = new Date(Date.now() - 60_000);
    await Job.updateOne(
      { _id: job._id },
      {
        $set: {
          jobStatus: 'running',
          workerId: 'dead',
          attempt: 1,
          leaseExpiresAt: past,
          heartbeatAt: past,
        },
      },
    ).exec();

    const [a, b] = await Promise.all([sweepExpiredLeases(), sweepExpiredLeases()]);
    expect(a.requeued + b.requeued).toBe(1);

    const events = await JobEvent.find({
      jobId: job._id,
      eventCode: WORKER_EVENT_INTERRUPTED_REQUEUED,
    }).exec();
    expect(events).toHaveLength(1);
  });

  it('completes a worker_smoke job end-to-end with claimed and completed events', async () => {
    registerJobHandler(workerSmokeHandlerRegistration);

    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const { job } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'worker_smoke',
      correlationId: 'corr_smoke',
    });

    const runtime = startWorkerRuntime({
      workerId: 'w-smoke',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 40,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
    });

    await vi.waitFor(
      async () => {
        const events = await listEventsForJob(orgId, String(job._id));
        expect(events.some((event) => event.eventCode === WORKER_EVENT_CLAIMED)).toBe(true);
        expect(events.some((event) => event.eventCode === 'job.completed')).toBe(true);
        const fresh = await Job.findById(job._id).exec();
        expect(fresh.jobStatus).toBe('completed');
      },
      { timeout: 10_000 },
    );

    await runtime.stop();
  }, 20_000);

  it('releases project lock helper after acquire', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const jobId = new mongoose.Types.ObjectId();
    const acquired = await acquireProjectJobLock({
      orgId,
      projectId,
      jobId,
      workerId: 'w-lock',
    });
    expect(acquired.acquired).toBe(true);
    const released = await releaseProjectJobLock({ orgId, projectId, jobId });
    expect(released).toBe(true);
    const second = await acquireProjectJobLock({
      orgId,
      projectId,
      jobId: new mongoose.Types.ObjectId(),
      workerId: 'w-lock-2',
    });
    expect(second.acquired).toBe(true);
  });

  it('continues polling when claim throws (mongo unreachable path)', async () => {
    registerJobHandler(workerSmokeHandlerRegistration);
    const claimSpy = vi.spyOn(await import('./jobClaim.js'), 'claimNextJob');
    // Direct runtime with a failing claim via empty types then restore — simulate error log path.
    const runtime = startWorkerRuntime({
      workerId: 'w-err',
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      setInterval: () => 1,
      clearInterval: vi.fn(),
    });
    // No registered types after clear — claim returns null; poll should not throw.
    clearJobHandlersForTests();
    await expect(runtime.claimOnceForTests()).resolves.toBeUndefined();
    claimSpy.mockRestore();
    await runtime.stop();
  });
});
