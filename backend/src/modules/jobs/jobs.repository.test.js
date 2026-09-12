/**
 * Jobs repository — pending create, pagination, event message caps, soft-delete visibility.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import {
  encodeCursor,
  softDelete,
  ROW_STATUS_DELETED,
} from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { Job } from './job.model.js';
import { JobEvent } from './jobEvent.model.js';
import {
  JOB_DEFAULT_MAX_ATTEMPTS,
  JOB_ENQUEUED_MESSAGE,
  JOB_EVENT_CODE_ENQUEUED,
  JOB_EVENT_MESSAGE_MAX_LENGTH,
  JOB_LIST_PAGE_SIZE_DEFAULT,
  JOB_LIST_PAGE_SIZE_MAX,
} from './jobs.constants.js';
import {
  appendJobEvent,
  assertJobEventMessageLength,
  clampJobListLimit,
  findJobById,
  insertPendingJob,
  isKnownJobStatus,
  listEventsForJob,
  listJobsByProject,
} from './jobs.repository.js';

const harness = createMongoHarness({
  models: [Job, JobEvent],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('jobs.repository', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('clamps list limits and recognizes jobStatus values', () => {
    expect(clampJobListLimit(undefined)).toBe(JOB_LIST_PAGE_SIZE_DEFAULT);
    expect(clampJobListLimit(0)).toBe(JOB_LIST_PAGE_SIZE_DEFAULT);
    expect(clampJobListLimit(999)).toBe(JOB_LIST_PAGE_SIZE_MAX);
    expect(clampJobListLimit(7)).toBe(7);
    expect(isKnownJobStatus('pending')).toBe(true);
    expect(isKnownJobStatus('retrying')).toBe(true);
    expect(isKnownJobStatus('nope')).toBe(false);
  });

  it('createPending writes pending job, null checkpoint, and job.enqueued event', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();

    const { job, event } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
      createdBy: actor,
      correlationId: 'req_test_1',
    });

    expect(job.jobStatus).toBe('pending');
    expect(job.stageCheckpoint).toBeNull();
    expect(job.maxAttempts).toBe(JOB_DEFAULT_MAX_ATTEMPTS);
    expect(job.scheduledAt).toBeInstanceOf(Date);
    expect(job.progressCounters.itemsProcessed).toBe(0);
    expect(event.eventCode).toBe(JOB_EVENT_CODE_ENQUEUED);
    expect(event.message).toBe(JOB_ENQUEUED_MESSAGE);
    expect(event.severity).toBe('info');
    expect(String(event.jobId)).toBe(String(job._id));

    const events = await listEventsForJob(orgId, String(job._id));
    expect(events).toHaveLength(1);
  });

  it('rejects event messages over the max length without truncating', () => {
    expect(() => assertJobEventMessageLength('x'.repeat(JOB_EVENT_MESSAGE_MAX_LENGTH + 1))).toThrow(
      ApiError,
    );
    expect(() =>
      assertJobEventMessageLength('x'.repeat(JOB_EVENT_MESSAGE_MAX_LENGTH)),
    ).not.toThrow();
  });

  it('appendJobEvent rejects oversized messages', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const jobId = new mongoose.Types.ObjectId();
    await expect(
      appendJobEvent({
        orgId,
        projectId,
        jobId,
        eventCode: 'job.test',
        severity: 'info',
        message: 'y'.repeat(JOB_EVENT_MESSAGE_MAX_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('scopes list/find by org and project; excludes soft-deleted; returns failed active jobs', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    const projectA = new mongoose.Types.ObjectId();
    const projectB = new mongoose.Types.ObjectId();

    const { job: jobA } = await insertPendingJob({
      orgId: orgA,
      projectId: projectA,
      jobType: 'ingest',
    });
    const { job: failed } = await insertPendingJob({
      orgId: orgA,
      projectId: projectA,
      jobType: 'ingest',
    });
    failed.jobStatus = 'failed';
    failed.failureClass = 'permanent';
    await failed.save();

    const { job: soft } = await insertPendingJob({
      orgId: orgA,
      projectId: projectA,
      jobType: 'ingest',
    });
    await softDelete(Job, { _id: soft._id, orgId: orgA });

    await insertPendingJob({
      orgId: orgB,
      projectId: projectB,
      jobType: 'ingest',
    });
    await insertPendingJob({
      orgId: orgA,
      projectId: projectB,
      jobType: 'ingest',
    });

    const listed = await listJobsByProject(orgA, String(projectA));
    expect(listed.items.map((row) => String(row._id)).sort()).toEqual(
      [String(jobA._id), String(failed._id)].sort(),
    );
    expect(listed.items.some((row) => row.jobStatus === 'failed')).toBe(true);

    expect(await findJobById(orgA, String(soft._id))).toBeNull();
    expect(await findJobById(orgB, String(jobA._id))).toBeNull();
    soft.status = ROW_STATUS_DELETED;
    await soft.save();
  });

  it('paginates by createdAt keyset without duplicates', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      const { job } = await insertPendingJob({
        orgId,
        projectId,
        jobType: 'ingest',
        scheduledAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      });
      job.createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      await job.save();
      created.push(job);
    }

    const page1 = await listJobsByProject(orgId, String(projectId), { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.pageInfo.hasMore).toBe(true);
    expect(page1.pageInfo.nextCursor).toBeTruthy();

    const page2 = await listJobsByProject(orgId, String(projectId), {
      limit: 2,
      cursor: page1.pageInfo.nextCursor,
    });
    expect(page2.items).toHaveLength(2);
    const ids = [...page1.items, ...page2.items].map((row) => String(row._id));
    expect(new Set(ids).size).toBe(4);

    const page3 = await listJobsByProject(orgId, String(projectId), {
      limit: 2,
      cursor: page2.pageInfo.nextCursor,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.pageInfo.hasMore).toBe(false);
    expect(page3.pageInfo.nextCursor).toBeNull();

    const allIds = [...ids, String(page3.items[0]._id)];
    expect(new Set(allIds).size).toBe(5);
  });

  it('filters by jobStatus and accepts custom maxAttempts', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const { job: pending } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
      maxAttempts: 3,
    });
    expect(pending.maxAttempts).toBe(3);
    const { job: failed } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
    });
    failed.jobStatus = 'failed';
    await failed.save();

    const onlyFailed = await listJobsByProject(orgId, String(projectId), {
      jobStatus: 'failed',
    });
    expect(onlyFailed.items).toHaveLength(1);
    expect(String(onlyFailed.items[0]._id)).toBe(String(failed._id));
  });

  it('rejects unknown jobStatus filter and invalid cursors', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    await expect(
      listJobsByProject(orgId, String(projectId), { jobStatus: 'not-a-status' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      listJobsByProject(orgId, String(projectId), { cursor: '%%%' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    await expect(
      listJobsByProject(orgId, String(projectId), {
        cursor: encodeCursor({ t: 'not-a-date', i: new mongoose.Types.ObjectId().toHexString() }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});
