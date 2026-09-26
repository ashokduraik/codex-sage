/**
 * Jobs service unit tests for createPendingJob return shape and ACL outcomes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { Job } from '../../../src/models/job.model.js';
import { createPendingJob, getJobById } from '../../../src/modules/masters/jobs.js';
import { findJobById, appendJobEvent, insertPendingJob } from '../../../src/modules/masters/jobs.helper.js';
import { JOB_EVENT_CODE_ENQUEUED } from '../../../src/modules/masters/jobs.helper.js';
import { listJobEvents } from '../../listJobEvents.js';

vi.mock('../../../src/modules/masters/projectMembers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveProjectPermissions: vi.fn(),
  };
});

import { resolveProjectPermissions } from '../../../src/modules/masters/projectMembers.js';

const harness = createMongoHarness({
  models: [Job],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('jobs.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('createPendingJob returns ids and persists pending state', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId().toHexString();
    const result = await createPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
      correlationId: 'corr_1',
    });
    expect(result.jobId).toMatch(/^[a-f0-9]{24}$/);
    expect(result.eventId).toMatch(/^[a-f0-9]{24}$/);

    const job = await findJobById(orgId, result.jobId);
    expect(job?.jobStatus).toBe('pending');
    expect(job?.stageCheckpoint).toBeNull();
    const events = await listJobEvents(orgId, result.jobId);
    expect(events[0]?.eventCode).toBe(JOB_EVENT_CODE_ENQUEUED);
  });

  it('getJobById returns the embedded timeline from the job row', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId().toHexString();
    const { jobId } = await createPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
    });
    resolveProjectPermissions.mockResolvedValueOnce({
      kind: 'OK',
      visible: true,
      permissions: ['projects.view'],
    });
    const detail = await getJobById(orgId, new mongoose.Types.ObjectId().toHexString(), jobId);
    expect(detail.events[0]?.eventCode).toBe(JOB_EVENT_CODE_ENQUEUED);
  });

  it('getJobById returns FORBIDDEN when visible but missing projects.view', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId().toHexString();
    const { jobId } = await createPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
    });
    resolveProjectPermissions.mockResolvedValueOnce({
      kind: 'OK',
      visible: true,
      permissions: ['org.view'],
    });
    await expect(getJobById(orgId, new mongoose.Types.ObjectId().toHexString(), jobId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('getJobById returns JOB_NOT_FOUND when ACL is NO_ACCESS', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId().toHexString();
    const { jobId } = await createPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
    });
    resolveProjectPermissions.mockResolvedValueOnce({ kind: 'NO_ACCESS' });
    await expect(getJobById(orgId, new mongoose.Types.ObjectId().toHexString(), jobId)).rejects.toMatchObject({
      code: 'JOB_NOT_FOUND',
    });
  });

  it('appendJobEvent stores allowlisted data and listEvents ignores bad ids', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const { job } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
    });
    const event = await appendJobEvent({
      orgId,
      projectId,
      jobId: job._id,
      eventCode: 'job.test',
      severity: 'warning',
      message: 'A warning occurred.',
      data: { count: 2 },
    });
    expect(event.data).toEqual({ count: 2 });
    const coerced = await appendJobEvent({
      orgId,
      projectId,
      jobId: job._id,
      eventCode: 'job.test_plain',
      severity: 'info',
      message: 'No data object.',
      data: 'not-an-object',
    });
    expect(coerced.data).toEqual({});
    expect(await listJobEvents(orgId, 'not-an-id')).toEqual([]);
  });
});
