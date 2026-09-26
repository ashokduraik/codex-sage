/**
 * Retention soft-delete windows and scheduler enqueue tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AuditEvent } from '../../../src/models/audit.model.js';
import { Conversation } from '../../../src/models/conversations.model.js';
import { Job } from '../../../src/models/job.model.js';
import { KnowledgeVersion } from '../../../src/models/knowledgeVersion.model.js';
import { Message } from '../../../src/models/messages.model.js';
import { Notification } from '../../../src/models/notification.model.js';
import { Organization } from '../../../src/models/organization.model.js';
import { Project } from '../../../src/models/projects.model.js';
import { SourceFile } from '../../../src/models/sourceFile.model.js';
import { SourceVersion } from '../../../src/models/sourceVersion.model.js';
import { ProjectActivity } from '../../../src/models/projectActivity.model.js';
import { ROW_STATUS_DELETED, includeDeleted } from '../../../src/platform/data/index.js';
import { enqueueDueRetentionJobs, nextUtcMidnight, runRetentionForOrg, runRetentionJob } from '../../../src/modules/masters/retention.js';

const harness = createMongoHarness({
  models: [AuditEvent, Conversation, Job, KnowledgeVersion, Message, Notification, Organization, Project, SourceFile, SourceVersion, ProjectActivity],
  uri: TEST_APP_CONFIG.mongo.uri,
});

const NOW = new Date('2026-09-26T12:00:00.000Z');

/**
 * @param {string} orgId Tenant.
 * @param {string} projectId Project.
 * @returns {Promise<void>}
 */
async function insertProject(orgId, projectId) {
  await Project.create({
    _id: projectId,
    orgId,
    name: 'Retention fixture',
    description: '',
    lifecycleStatus: 'knowledge_ready',
    knowledgeHealth: 'ready',
    sourceConfig: { sourceType: 'upload' },
    counts: { sourceVersions: 5, files: 5, excludedFiles: 0, conversations: 0 },
    settings: {},
    createdBy: null,
    updatedBy: null,
  });
}

/**
 * @param {{ orgId: string, projectId: string, publishedAt: Date, current?: boolean }} input Version pair.
 * @returns {Promise<{ sourceVersionId: mongoose.Types.ObjectId, knowledgeId: mongoose.Types.ObjectId }>}
 */
async function insertReadyPair(input) {
  const sourceVersionId = new mongoose.Types.ObjectId();
  const knowledgeId = new mongoose.Types.ObjectId();
  await SourceVersion.create({
    _id: sourceVersionId,
    orgId: input.orgId,
    projectId: input.projectId,
    origin: 'upload',
    exclusionRulesetId: 'exclusions.v1',
    versionLifecycle: 'accepted',
    fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    createdBy: null,
    updatedBy: null,
  });
  await SourceFile.create({
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId,
    path: `${String(sourceVersionId)}.js`,
    sha256: 'c'.repeat(64),
    byteLength: 8,
    kind: 'code',
    gridFsId: new mongoose.Types.ObjectId(),
    excludedFromGraph: false,
    fileState: 'stored',
    createdBy: null,
    updatedBy: null,
  });
  await KnowledgeVersion.create({
    _id: knowledgeId,
    orgId: input.orgId,
    projectId: input.projectId,
    sourceVersionId,
    graphIdentity: {
      graphHash: 'h',
      indexedAt: input.publishedAt.toISOString(),
      sourceVersionId: String(sourceVersionId),
      indexedFileCount: 1,
      skippedFileCount: 0,
      mode: 'indexAll',
      graphDir: '.codegraph',
    },
    publishedHealth: 'ready',
    excludedFileCount: 0,
    publishedAt: input.publishedAt,
    createdBy: null,
    updatedBy: null,
  });
  if (input.current) {
    await Project.updateOne({ _id: input.projectId }, { $set: { currentKnowledgeVersionId: knowledgeId } });
  }
  return { sourceVersionId, knowledgeId };
}

describe('retention.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('returns the next UTC midnight', () => {
    expect(nextUtcMidnight(new Date('2026-09-26T15:04:00.000Z')).toISOString()).toBe('2026-09-27T00:00:00.000Z');
  });

  it('keeps the last three ready source versions and hides older files', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId().toHexString();
    await insertProject(orgId, projectId);
    const oldest = await insertReadyPair({
      orgId,
      projectId,
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await insertReadyPair({
      orgId,
      projectId,
      publishedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await insertReadyPair({
      orgId,
      projectId,
      publishedAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    await insertReadyPair({
      orgId,
      projectId,
      publishedAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    await insertReadyPair({
      orgId,
      projectId,
      publishedAt: new Date('2026-05-01T00:00:00.000Z'),
      current: true,
    });

    const summary = await runRetentionForOrg(orgId, NOW);
    expect(summary.sourceVersions).toBe(2);
    expect(await SourceVersion.countDocuments({ orgId })).toBe(3);
    expect(await KnowledgeVersion.countDocuments({ orgId })).toBe(3);
    expect(await SourceFile.countDocuments({ orgId })).toBe(3);
    const hiddenSource = await includeDeleted(SourceVersion.findOne({ _id: oldest.sourceVersionId })).exec();
    expect(hiddenSource.status).toBe(ROW_STATUS_DELETED);
  });

  it('hides terminal jobs older than 180 days and leaves running jobs', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId();
    await insertProject(orgId, String(projectId));
    await Job.create([
      {
        orgId,
        projectId,
        jobType: 'ingest',
        jobStatus: 'completed',
        completedAt: new Date('2026-01-01T00:00:00.000Z'),
        createdBy: null,
        updatedBy: null,
      },
      {
        orgId,
        projectId,
        jobType: 'ingest',
        jobStatus: 'running',
        completedAt: null,
        createdBy: null,
        updatedBy: null,
      },
      {
        orgId,
        projectId,
        jobType: 'ingest',
        jobStatus: 'failed',
        completedAt: new Date('2026-09-01T00:00:00.000Z'),
        createdBy: null,
        updatedBy: null,
      },
    ]);
    const summary = await runRetentionForOrg(orgId, NOW);
    expect(summary.jobs).toBe(1);
    expect(await Job.countDocuments({ orgId, jobStatus: 'running' })).toBe(1);
    expect(await Job.countDocuments({ orgId, jobStatus: 'failed' })).toBe(1);
  });

  it('hides unread notifications after 90 days or 30 days after read', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const userId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const [oldUnread, oldRead, fresh] = await Notification.create([
      {
        orgId,
        userId,
        type: 'knowledge.completed',
        title: 'old unread',
        body: 'x',
        resourceRef: { projectId },
        readAt: null,
        dedupeKey: 'old-unread',
        createdBy: null,
        updatedBy: null,
      },
      {
        orgId,
        userId,
        type: 'knowledge.completed',
        title: 'old read',
        body: 'x',
        resourceRef: { projectId },
        readAt: new Date('2026-08-01T00:00:00.000Z'),
        dedupeKey: 'old-read',
        createdBy: null,
        updatedBy: null,
      },
      {
        orgId,
        userId,
        type: 'knowledge.completed',
        title: 'fresh',
        body: 'x',
        resourceRef: { projectId },
        readAt: new Date('2026-09-20T00:00:00.000Z'),
        dedupeKey: 'fresh',
        createdBy: null,
        updatedBy: null,
      },
    ]);
    await Notification.collection.updateOne({ _id: oldUnread._id }, { $set: { createdAt: new Date('2026-05-01T00:00:00.000Z') } });
    void oldRead;
    void fresh;
    const summary = await runRetentionForOrg(orgId, NOW);
    expect(summary.notifications).toBe(2);
    expect(await Notification.countDocuments({ orgId })).toBe(1);
  });

  it('hides usage older than 730 days, archived conversations, and aged audit', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    const projectId = new mongoose.Types.ObjectId();
    const conversationId = new mongoose.Types.ObjectId();
    await insertProject(orgId, String(projectId));
    await ProjectActivity.create({
      orgId,
      projectId,
      kind: 'search.executed',
      quantity: 1,
      unit: 'calls',
      sourceRef: 'old',
      dedupeKey: 'old-search',
      occurredAt: new Date('2024-01-01T00:00:00.000Z'),
      createdBy: null,
      updatedBy: null,
    });
    await Conversation.create({
      _id: conversationId,
      orgId,
      projectId,
      ownerUserId: new mongoose.Types.ObjectId(),
      title: 'Old thread',
      titleSource: 'user',
      lifecycleStatus: 'archived',
      archivedAt: new Date('2025-01-01T00:00:00.000Z'),
      createdBy: null,
      updatedBy: null,
    });
    await Message.create({
      orgId,
      projectId,
      conversationId,
      role: 'user',
      content: 'hello',
      messageStatus: 'completed',
      createdBy: null,
      updatedBy: null,
    });
    const audit = await AuditEvent.create({
      orgId,
      action: 'project.create',
      resourceType: 'project',
      resourceId: String(projectId),
      result: 'success',
      correlationId: 'corr-old',
    });
    await AuditEvent.collection.updateOne({ _id: audit._id }, { $set: { createdAt: new Date('2024-01-01T00:00:00.000Z') } });

    const summary = await runRetentionForOrg(orgId, NOW);
    expect(summary.projectActivities).toBe(1);
    expect(summary.conversations).toBe(1);
    expect(summary.audit).toBe(1);
    expect(await Conversation.countDocuments({ orgId })).toBe(0);
    expect(await Message.countDocuments({ orgId })).toBe(0);
  });

  it('enqueues one retention job per org and skips when one is already active', async () => {
    const org = await Organization.create({
      code: `RETAIN_${new mongoose.Types.ObjectId().toHexString().slice(0, 8).toUpperCase()}`,
      name: 'Retain Co',
      slug: `retain-${new mongoose.Types.ObjectId().toHexString().slice(0, 8)}`,
      createdBy: null,
      updatedBy: null,
    });
    const first = await enqueueDueRetentionJobs({ now: NOW });
    expect(first.enqueued).toBeGreaterThanOrEqual(1);
    const second = await enqueueDueRetentionJobs({ now: NOW });
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    const jobs = await Job.find({ orgId: org._id, jobType: 'retention' });
    expect(jobs.length).toBe(1);
    expect(jobs[0].projectId).toBeNull();
  });

  it('runs the worker handler for the job org', async () => {
    const orgId = new mongoose.Types.ObjectId().toHexString();
    await insertProject(orgId, new mongoose.Types.ObjectId().toHexString());
    const result = await runRetentionJob({
      job: { orgId },
    });
    expect(result.result).toBe('completed');
    expect(result.summary).toMatchObject({ sourceVersions: 0, jobs: 0 });
  });

  it('logs enqueue failures without throwing', async () => {
    const log = { error: vi.fn() };
    const findSpy = vi.spyOn(Organization, 'find').mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: async () => [{ _id: new mongoose.Types.ObjectId() }],
        }),
      }),
    });
    const jobSpy = vi.spyOn(Job, 'findOne').mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: async () => {
            throw new Error('claim failed');
          },
        }),
      }),
    });
    await expect(enqueueDueRetentionJobs({ log, now: NOW })).resolves.toEqual({ enqueued: 0, skipped: 1 });
    expect(log.error).toHaveBeenCalled();
    jobSpy.mockRestore();
    const nonErrorSpy = vi.spyOn(Job, 'findOne').mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: async () => {
            throw 'claim failed';
          },
        }),
      }),
    });
    await expect(enqueueDueRetentionJobs({ log })).resolves.toEqual({ enqueued: 0, skipped: 1 });
    findSpy.mockRestore();
    nonErrorSpy.mockRestore();
  });
});
