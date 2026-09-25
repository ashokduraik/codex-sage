/**
 * Reingest enqueue service tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { JOB_MODELS, Job } from '../jobs/index.js';
import { EXCLUSION_RULESET_ID } from './exclusions/exclusions.constants.js';
import { SourceFile, SourceVersion } from './index.js';
import { insertSourceVersion } from './sources.repository.js';
import { enqueueSourceReingest, mapSourceVersionToListDto } from './sources.service.js';

const harness = createMongoHarness({
  models: [...JOB_MODELS, SourceVersion, SourceFile],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('enqueueSourceReingest', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('creates a pending reingest job for an active source version', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    await insertSourceVersion({
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(actor),
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    });

    const result = await enqueueSourceReingest({
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      actorUserId: String(actor),
      correlationId: 'corr-1',
    });
    expect(result.jobType).toBe('reingest');
    expect(result.sourceVersionId).toBe(String(sourceVersionId));
    const job = await Job.findById(result.jobId).exec();
    expect(job?.jobType).toBe('reingest');
    expect(job?.jobStatus).toBe('pending');
  });

  it('returns the active job for the same source version instead of creating another', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    await insertSourceVersion({
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(actor),
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    });
    const first = await enqueueSourceReingest({
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      actorUserId: String(actor),
    });
    const second = await enqueueSourceReingest({
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      actorUserId: String(actor),
    });
    expect(second.jobId).toBe(first.jobId);
    expect(await Job.countDocuments({ orgId, projectId })).toBe(1);
  });

  it('throws SOURCE_VERSION_NOT_FOUND for a missing or cross-project version', async () => {
    const orgId = new mongoose.Types.ObjectId();
    await expect(
      enqueueSourceReingest({
        orgId: String(orgId),
        projectId: String(new mongoose.Types.ObjectId()),
        sourceVersionId: String(new mongoose.Types.ObjectId()),
        actorUserId: String(new mongoose.Types.ObjectId()),
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_VERSION_NOT_FOUND' });
  });
});

describe('mapSourceVersionToListDto', () => {
  it('maps ids and file counts with null-safe fallbacks', () => {
    expect(
      mapSourceVersionToListDto({
        _id: '665a00000000000000000001',
        origin: 'upload',
        versionLifecycle: 'accepted',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ).toEqual({
      id: '665a00000000000000000001',
      origin: 'upload',
      versionLifecycle: 'accepted',
      fileCounts: { accepted: 0, skipped: 0, excludedFromGraph: 0 },
      jobId: null,
      commitSha: null,
      branch: null,
      createdBy: null,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
  });
});
