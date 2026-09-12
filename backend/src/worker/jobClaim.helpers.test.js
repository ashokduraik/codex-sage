/**
 * Integration coverage for jobClaim finish / requeue / cancel / checkpoint helpers.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../test/appConfig.js';
import { Job } from '../modules/jobs/job.model.js';
import { JobEvent } from '../modules/jobs/jobEvent.model.js';
import { insertPendingJob } from '../modules/jobs/jobs.repository.js';
import {
  claimNextJob,
  finishJobCancelled,
  finishJobCompleted,
  finishJobFailed,
  requeueJobTemporaryFailure,
  releaseJobOnShutdown,
  resolveNextDueAt,
  saveJobCheckpoint,
  saveJobProgress,
} from './jobClaim.js';
import { ProjectJobLock } from './projectJobLock.model.js';
import { createJobLogger, buildJobLogBindings } from './workerLogger.js';
import { runWorkerSmokeHandler } from './handlers/workerSmokeHandler.js';
import { refreshProjectJobLock, releaseProjectJobLock, acquireProjectJobLock } from './projectJobLock.js';

const harness = createMongoHarness({
  models: [Job, JobEvent, ProjectJobLock],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('jobClaim helpers', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('finishes completed, completed_with_warnings, failed, cancelled, and temporary requeue', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();

    async function claimSmoke(workerId) {
      await insertPendingJob({ orgId, projectId, jobType: 'worker_smoke' });
      return claimNextJob({ workerId, registeredTypes: ['worker_smoke'] });
    }

    const completed = await claimSmoke('w-complete');
    await finishJobCompleted({
      jobId: completed._id,
      workerId: 'w-complete',
      result: 'completed',
      summary: { ok: true },
    });
    expect((await Job.findById(completed._id)).jobStatus).toBe('completed');

    const warned = await claimSmoke('w-warn');
    await finishJobCompleted({
      jobId: warned._id,
      workerId: 'w-warn',
      result: 'completed_with_warnings',
    });
    expect((await Job.findById(warned._id)).jobStatus).toBe('completed_with_warnings');

    const failed = await claimSmoke('w-fail');
    await finishJobFailed({
      jobId: failed._id,
      workerId: 'w-fail',
      failureClass: 'permanent',
      failureCode: 'BAD',
      message: 'nope',
    });
    expect((await Job.findById(failed._id)).jobStatus).toBe('failed');

    const cancelled = await claimSmoke('w-cancel');
    await finishJobCancelled({ jobId: cancelled._id, workerId: 'w-cancel' });
    expect((await Job.findById(cancelled._id)).jobStatus).toBe('cancelled');

    const retry = await claimSmoke('w-retry');
    await requeueJobTemporaryFailure({
      jobId: retry._id,
      workerId: 'w-retry',
      delayMs: 1000,
      failureCode: 'TEMP',
      message: 'retry later',
    });
    const retried = await Job.findById(retry._id);
    expect(retried.jobStatus).toBe('pending');
    expect(retried.failureCode).toBe('TEMP');

    const shutdown = await claimSmoke('w-shut');
    await releaseJobOnShutdown({ jobId: shutdown._id, workerId: 'w-shut' });
    expect((await Job.findById(shutdown._id)).jobStatus).toBe('pending');

    const exhausted = await claimSmoke('w-exh');
    await finishJobFailed({
      jobId: exhausted._id,
      workerId: 'w-exh',
      failureClass: 'temporary',
      failureCode: 'X',
      message: 'out',
      attemptsExhausted: true,
    });
    expect((await Job.findById(exhausted._id)).jobStatus).toBe('failed');
  });

  it('saves a checkpoint and resolves nextDueAt helpers', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    await insertPendingJob({ orgId, projectId, jobType: 'worker_smoke' });
    const job = await claimNextJob({
      workerId: 'w-cp',
      registeredTypes: ['worker_smoke'],
    });

    const saved = await saveJobCheckpoint({
      jobId: job._id,
      workerId: 'w-cp',
      checkpoint: { lastCompletedStage: 'a', cursor: { page: 1 } },
      currentStage: 'a',
    });
    expect(saved).toBe(true);
    const fresh = await Job.findById(job._id);
    expect(fresh.stageCheckpoint.lastCompletedStage).toBe('a');
    expect(fresh.stageCheckpoint.cursor).toEqual({ page: 1 });

    const progressSaved = await saveJobProgress({
      jobId: job._id,
      workerId: 'w-cp',
      progressCounters: {
        itemsProcessed: 12,
        itemsFailed: 1,
        warningCount: 1,
        excludedCount: 3,
      },
      currentStage: 'store_files',
      partialSuccess: true,
    });
    expect(progressSaved).toBe(true);
    const withProgress = await Job.findById(job._id);
    expect(withProgress.progressCounters.itemsProcessed).toBe(12);
    expect(withProgress.progressCounters.excludedCount).toBe(3);
    expect(withProgress.partialSuccess).toBe(true);
    expect(withProgress.currentStage).toBe('store_files');

    expect(resolveNextDueAt(new Date('2030-01-01T00:00:00.000Z')).toISOString()).toBe(
      '2030-01-01T00:00:00.000Z',
    );
    expect(resolveNextDueAt(5000).getTime()).toBeGreaterThan(Date.now());
    expect(() => resolveNextDueAt('bad')).toThrow(/nextDueAt/);
  });

  it('takes over same-job lock and throws on non-duplicate create errors', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const jobId = new mongoose.Types.ObjectId();
    await acquireProjectJobLock({ orgId, projectId, jobId, workerId: 'w-same' });
    // Second acquire by same worker/job should refresh and succeed.
    expect(
      await acquireProjectJobLock({ orgId, projectId, jobId, workerId: 'w-same' }),
    ).toEqual({ acquired: true });

    const { ProjectJobLock: LockModel } = await import('./projectJobLock.model.js');
    const createSpy = vi.spyOn(LockModel, 'create').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      acquireProjectJobLock({
        orgId: new mongoose.Types.ObjectId(),
        projectId: new mongoose.Types.ObjectId(),
        jobId: new mongoose.Types.ObjectId(),
        workerId: 'w-err',
      }),
    ).rejects.toThrow(/disk full/);
    createSpy.mockRestore();
  });
});

describe('workerLogger and smoke handler', () => {
  it('builds bindings and child loggers for pino-like and plain parents', () => {
    const bindings = buildJobLogBindings({
      workerId: 'w',
      jobId: 'j',
      jobType: 'worker_smoke',
      orgId: 'o',
      projectId: 'p',
      attempt: 1,
    });
    expect(bindings.stage).toBeNull();

    const child = { info: () => undefined };
    const parentWithChild = {
      child: (b) => ({ ...child, bindings: b }),
    };
    expect(createJobLogger(parentWithChild, bindings).bindings).toEqual(bindings);

    const plain = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const wrapped = createJobLogger(plain, bindings);
    expect(wrapped.bindings).toEqual(bindings);
    wrapped.debug({}, 'd');
    wrapped.info({}, 'i');
    wrapped.warn({}, 'w');
    wrapped.error({}, 'e');
  });

  it('smoke handler resumes when checkpoint already complete', async () => {
    const calls = [];
    const result = await runWorkerSmokeHandler({
      stageCheckpoint: { lastCompletedStage: 'smoke_done' },
      log: { info: (obj, msg) => calls.push(msg) },
      saveCheckpoint: async () => {
        throw new Error('should not save');
      },
    });
    expect(result).toEqual({ result: 'completed', summary: { resumed: true } });
    expect(calls.length).toBe(1);
  });
});
