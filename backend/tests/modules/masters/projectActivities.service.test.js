/**
 * Project activity recording and usage-summary read tests.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { SourceFile } from '../../../src/models/sourceFile.model.js';
import { ProjectActivity } from '../../../src/models/projectActivity.model.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getMyUsageHttp,
  loadUsageSummary,
  getProjectUsageHttp,
  recordProjectActivity,
  sumAcceptedSourceBytes,
  getOrganizationUsageHttp,
  recordProjectActivitiesForJobTerminal,
} from '../../../src/modules/masters/projectActivities.js';

const harness = createMongoHarness({
  models: [ProjectActivity, SourceFile],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('projectActivities.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('records a fact once and ignores a duplicate dedupeKey', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId().toHexString();
    const userId = new mongoose.Types.ObjectId().toHexString();
    const first = await recordProjectActivity({
      orgId,
      projectId,
      userId,
      kind: 'search.executed',
      quantity: 1,
      unit: 'calls',
      sourceRef: 'req-1',
      dedupeKey: 'search.executed:req-1',
      occurredAt: new Date('2026-09-26T10:00:00.000Z'),
    });
    const second = await recordProjectActivity({
      orgId,
      projectId,
      userId,
      kind: 'search.executed',
      quantity: 1,
      unit: 'calls',
      sourceRef: 'req-1',
      dedupeKey: 'search.executed:req-1',
      occurredAt: new Date('2026-09-26T11:00:00.000Z'),
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await ProjectActivity.countDocuments({ orgId })).toBe(1);
    const summary = await loadUsageSummary({
      orgId,
      from: new Date('2026-09-26T00:00:00.000Z'),
      to: new Date('2026-09-26T23:59:59.000Z'),
    });
    expect(summary.totals.searchesExecuted).toBe(1);
    expect(summary.byProject[0].projectId).toBe(projectId);
    expect(summary.byUser[0].userId).toBe(userId);
  });

  it('skips a write when projectId is missing', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const written = await recordProjectActivity({
      orgId,
      projectId: null,
      kind: 'search.executed',
      quantity: 1,
      unit: 'calls',
      sourceRef: 'req-2',
      dedupeKey: 'search.executed:req-2',
    });
    expect(written).toBe(false);
    expect(await ProjectActivity.countDocuments({ orgId })).toBe(0);
  });

  it('ignores unknown kinds and logs record failures without throwing', async () => {
    const log = { error: vi.fn() };
    await expect(
      recordProjectActivity({
        orgId: new mongoose.Types.ObjectId().toHexString(),
        projectId: new mongoose.Types.ObjectId().toHexString(),
        kind: 'tokens.prompt',
        quantity: 1,
        unit: 'tokens',
        sourceRef: 'x',
        dedupeKey: 'tokens:x',
        log,
      }),
    ).resolves.toBe(false);
    await expect(
      recordProjectActivity({
        orgId: 'not-an-id',
        projectId: new mongoose.Types.ObjectId().toHexString(),
        kind: 'search.executed',
        quantity: 1,
        unit: 'calls',
        sourceRef: 'x',
        dedupeKey: 'bad',
        log,
      }),
    ).resolves.toBe(false);
    expect(log.error).toHaveBeenCalled();
  });

  it('records ingest completion and accepted bytes from stored files', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId().toHexString();
    const sourceVersionId = new mongoose.Types.ObjectId();
    const jobId = new mongoose.Types.ObjectId();
    await SourceFile.create([
      {
        orgId,
        projectId,
        sourceVersionId,
        path: 'a.js',
        sha256: 'a'.repeat(64),
        byteLength: 40,
        kind: 'code',
        gridFsId: new mongoose.Types.ObjectId(),
        excludedFromGraph: false,
        fileState: 'stored',
        createdBy: null,
        updatedBy: null,
      },
      {
        orgId,
        projectId,
        sourceVersionId,
        path: 'b.js',
        sha256: 'b'.repeat(64),
        byteLength: 60,
        kind: 'code',
        gridFsId: new mongoose.Types.ObjectId(),
        excludedFromGraph: false,
        fileState: 'stored',
        createdBy: null,
        updatedBy: null,
      },
    ]);
    expect(await sumAcceptedSourceBytes(orgId, String(sourceVersionId))).toBe(100);
    expect(await sumAcceptedSourceBytes(orgId, 'bad')).toBe(0);

    await recordProjectActivitiesForJobTerminal({
      job: {
        _id: jobId,
        orgId,
        projectId,
        jobType: 'project_knowledge_build',
        sourceVersionId,
        createdBy: new mongoose.Types.ObjectId(),
      },
    });
    expect(await ProjectActivity.countDocuments({ orgId })).toBe(2);
    // Terminal recording stamps occurredAt as now — window must include wall-clock time.
    const summary = await loadUsageSummary({
      orgId,
      from: new Date(Date.now() - 24 * 60 * 60 * 1000),
      to: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    expect(summary.totals.ingestJobsCompleted).toBe(1);
    expect(summary.totals.sourceBytesAccepted).toBe(100);
    expect(summary.byProject[0].projectId).toBe(projectId);
  });

  it('returns zero totals and scopes summary by project or user', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectA = new mongoose.Types.ObjectId().toHexString();
    const projectB = new mongoose.Types.ObjectId().toHexString();
    const userA = new mongoose.Types.ObjectId().toHexString();
    const empty = await loadUsageSummary({
      orgId,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.000Z'),
    });
    expect(empty.totals).toEqual({
      ingestJobsCompleted: 0,
      sourceBytesAccepted: 0,
      searchesExecuted: 0,
    });
    await recordProjectActivity({
      orgId,
      projectId: projectA,
      userId: userA,
      kind: 'search.executed',
      quantity: 1,
      unit: 'calls',
      sourceRef: 'a',
      dedupeKey: 'search.executed:a',
      occurredAt: new Date('2026-09-10T00:00:00.000Z'),
    });
    await recordProjectActivity({
      orgId,
      projectId: projectB,
      userId: new mongoose.Types.ObjectId().toHexString(),
      kind: 'search.executed',
      quantity: 1,
      unit: 'calls',
      sourceRef: 'b',
      dedupeKey: 'search.executed:b',
      occurredAt: new Date('2026-09-10T00:00:00.000Z'),
    });
    const forProject = await loadUsageSummary({
      orgId,
      projectId: projectA,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.000Z'),
    });
    expect(forProject.totals.searchesExecuted).toBe(1);
    expect(forProject.byProject).toHaveLength(1);
    const forUser = await loadUsageSummary({
      orgId,
      userId: userA,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.000Z'),
    });
    expect(forUser.totals.searchesExecuted).toBe(1);
    expect(forUser.byUser).toHaveLength(1);
  });

  it('skips activity for non-ingest job types and jobs without a project', async () => {
    await recordProjectActivitiesForJobTerminal({
      job: {
        _id: new mongoose.Types.ObjectId(),
        orgId: new mongoose.Types.ObjectId().toHexString(),
        projectId: new mongoose.Types.ObjectId().toHexString(),
        jobType: 'aged_org_data_cleanup',
      },
    });
    await recordProjectActivitiesForJobTerminal({
      job: {
        _id: new mongoose.Types.ObjectId(),
        orgId: new mongoose.Types.ObjectId().toHexString(),
        jobType: 'project_knowledge_build',
      },
    });
    expect(await ProjectActivity.countDocuments({})).toBe(0);
  });

  it('records only the job when sourceVersionId is missing or has no bytes', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId().toHexString();
    await recordProjectActivitiesForJobTerminal({
      job: {
        id: new mongoose.Types.ObjectId(),
        orgId,
        projectId,
        jobType: 'connected_repo_pull',
      },
    });
    await recordProjectActivitiesForJobTerminal({
      job: {
        _id: new mongoose.Types.ObjectId(),
        orgId,
        projectId,
        jobType: 'project_knowledge_rebuild',
        sourceVersionId: new mongoose.Types.ObjectId(),
      },
    });
    await recordProjectActivitiesForJobTerminal({ job: { jobType: 'project_knowledge_build' } });
    expect(await ProjectActivity.countDocuments({ orgId })).toBe(2);
  });

  it('serves usage handlers for the default window and valid from/to', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId().toHexString();
    const userId = new mongoose.Types.ObjectId().toHexString();
    const principal = { orgId, userId };
    const org = await getOrganizationUsageHttp({
      query: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T23:59:59.000Z' },
      principal,
    });
    expect(org.totals.searchesExecuted).toBe(0);
    const me = await getMyUsageHttp({ query: {}, principal });
    expect(me.totals.ingestJobsCompleted).toBe(0);
    const project = await getProjectUsageHttp({
      query: {},
      params: { projectId },
      principal,
    });
    expect(project.totals.sourceBytesAccepted).toBe(0);
    await expect(
      getOrganizationUsageHttp({
        query: { from: 'not-a-date' },
        principal,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
