/**
 * Tests for repository sync orchestration.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../../test/appConfig.js';
import { AUDIT_MODELS, listAuditEvents } from '../../audit/index.js';
import { JOB_MODELS, Job, insertPendingJob } from '../../jobs/index.js';
import { SOURCE_MODELS, SourceVersion, clearSourceFilesBucket } from '../../sources/index.js';
import { insertConnection } from '../repositories.repository.js';
import { RepositoryConnection } from '../repositoryConnection.model.js';
import {
  deferRepoSyncJob,
  enqueueManualRepositorySync,
  isProjectSyncBlocked,
  markConnectionSyncFailed,
  markConnectionSynced,
  persistRepositorySourceVersion,
} from './repoSync.service.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../sources/exclusions/fixtures',
);

const harness = createMongoHarness({
  models: [...SOURCE_MODELS, ...JOB_MODELS, ...AUDIT_MODELS, RepositoryConnection],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('repoSync.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
    await clearSourceFilesBucket();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('reports overlap from a writer lock or an active job', async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    const projectId = new mongoose.Types.ObjectId().toString();
    expect(
      await isProjectSyncBlocked({
        orgId,
        projectId,
        hasWriterLock: async () => true,
        findActiveJob: async () => null,
      }),
    ).toBe(true);
    expect(
      await isProjectSyncBlocked({
        orgId,
        projectId,
        hasWriterLock: async () => false,
        findActiveJob: async () => ({ _id: new mongoose.Types.ObjectId() }),
      }),
    ).toBe(true);
    expect(
      await isProjectSyncBlocked({
        orgId,
        projectId,
        hasWriterLock: async () => false,
        findActiveJob: async () => null,
      }),
    ).toBe(false);
  });

  it('persists a repository SourceVersion and enqueues ingest', async () => {
    const archiveBuffer = await readFile(path.join(fixturesDir, 'good.zip'));
    const orgId = new mongoose.Types.ObjectId().toString();
    const projectId = new mongoose.Types.ObjectId().toString();
    const connectionId = new mongoose.Types.ObjectId().toString();
    const result = await persistRepositorySourceVersion({
      orgId,
      projectId,
      connectionId,
      branch: 'main',
      commitSha: 'abc123def456',
      archiveBuffer,
      actorUserId: new mongoose.Types.ObjectId().toString(),
      correlationId: 'corr-sync',
    });
    expect(result.sourceVersionId).toBeTruthy();
    expect(result.ingestJobId).toBeTruthy();
    const version = await SourceVersion.findById(result.sourceVersionId).lean().exec();
    expect(version.origin).toBe('repository');
    expect(version.commitSha).toBe('abc123def456');
    expect(version.branch).toBe('main');
    const job = await Job.findById(result.ingestJobId).lean().exec();
    expect(job.jobType).toBe('ingest');
  });

  it('enqueues a manual sync and writes audit without a second job when one is active', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    await insertConnection({
      orgId,
      projectId,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/payments',
      repositoryWebUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
      nextDueAt: new Date(),
    });

    const first = await enqueueManualRepositorySync({
      orgId: String(orgId),
      projectId: String(projectId),
      actorUserId: String(actor),
      correlationId: 'sync-1',
      log: { info: vi.fn() },
    });
    expect(first.job.jobType).toBe('repo_sync');
    const second = await enqueueManualRepositorySync({
      orgId: String(orgId),
      projectId: String(projectId),
      actorUserId: String(actor),
      correlationId: 'sync-2',
    });
    expect(second.job.id).toBe(first.job.id);
    expect(await Job.countDocuments({ projectId, jobType: 'repo_sync' })).toBe(1);

    const events = await listAuditEvents(String(orgId), { limit: 10 });
    expect(events.items.some((row) => row.action === 'repository.sync_triggered')).toBe(true);
  });

  it('rejects archives that are empty after exclusions', async () => {
    const archiveBuffer = await readFile(path.join(fixturesDir, 'only-ignored.zip'));
    await expect(
      persistRepositorySourceVersion({
        orgId: new mongoose.Types.ObjectId().toString(),
        projectId: new mongoose.Types.ObjectId().toString(),
        connectionId: new mongoose.Types.ObjectId().toString(),
        branch: 'main',
        commitSha: 'abc',
        archiveBuffer,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS' });
  });

  it('schedules manual sync later when an overlapping ingest is active', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    await insertConnection({
      orgId,
      projectId,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/busy',
      repositoryWebUrl: 'https://github.com/acme/busy',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
    });
    const { job: ingest } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
    });
    await Job.updateOne({ _id: ingest._id }, { $set: { jobStatus: 'running' } });
    const result = await enqueueManualRepositorySync({
      orgId: String(orgId),
      projectId: String(projectId),
      actorUserId: String(actor),
    });
    expect(new Date(result.job.scheduledAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 404-equivalent when no connection exists', async () => {
    await expect(
      enqueueManualRepositorySync({
        orgId: new mongoose.Types.ObjectId().toString(),
        projectId: new mongoose.Types.ObjectId().toString(),
        actorUserId: new mongoose.Types.ObjectId().toString(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('marks connection synced and failed without touching lifecycle fields', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const created = await insertConnection({
      orgId,
      projectId,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/payments',
      repositoryWebUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
    });
    await markConnectionSynced({
      orgId: String(orgId),
      connectionId: String(created._id),
      commitSha: 'sha1',
      jobId: new mongoose.Types.ObjectId().toString(),
    });
    let row = await RepositoryConnection.findById(created._id).lean().exec();
    expect(row.lastSyncedCommitSha).toBe('sha1');
    expect(row.connectionStatus).toBe('connected');

    await markConnectionSyncFailed({
      orgId: String(orgId),
      connectionId: String(created._id),
      probeStatus: 'authentication_required',
      errorCode: 'token_invalid',
      jobId: new mongoose.Types.ObjectId().toString(),
    });
    row = await RepositoryConnection.findById(created._id).lean().exec();
    expect(row.connectionStatus).toBe('authentication_required');
    expect(row.lastSyncErrorCode).toBe('token_invalid');
    expect(row.lastSyncedCommitSha).toBe('sha1');
  });

  it('defers a running repo_sync job', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const { job } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'repo_sync',
    });
    await Job.updateOne({ _id: job._id }, { $set: { jobStatus: 'running', attempt: 3 } });
    const deferred = await deferRepoSyncJob({
      jobId: String(job._id),
      orgId: String(orgId),
      delayMs: 2_000,
    });
    expect(deferred?.jobStatus).toBe('pending');
    expect(deferred?.attempt).toBe(2);
  });
});
