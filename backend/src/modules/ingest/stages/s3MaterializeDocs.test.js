/**
 * Additional S3 materialize_docs cases (skipPaths, document parse warnings).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../../test/appConfig.js';
import * as documents from '../../documents/index.js';
import { DocumentSection } from '../../documents/index.js';
import { Job } from '../../jobs/job.model.js';
import { JobEvent } from '../../jobs/jobEvent.model.js';
import { insertPendingJob } from '../../jobs/jobs.repository.js';
import {
  EXCLUSION_RULESET_ID,
  SourceFile,
  SourceVersion,
  clearSourceFilesBucket,
  getSourceFilesBucket,
  insertSourceFiles,
  insertSourceVersion,
} from '../../sources/index.js';
import { buildIngestStageContext } from '../ingest.context.js';
import { loadSourceVersionForIngest } from '../ingest.repository.js';
import { runMaterializeDocsStage, WORKSPACE_MATERIALIZE_BATCH_SIZE } from './s3MaterializeDocs.js';

let workspaceRoot;

const harness = createMongoHarness({
  models: [Job, JobEvent, SourceVersion, SourceFile, DocumentSection],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @param {{ path: string, content: Buffer }} file File spec.
 * @returns {Promise<object>}
 */
async function seedOneVersion(file) {
  const orgId = new mongoose.Types.ObjectId();
  const projectId = new mongoose.Types.ObjectId();
  const sourceVersionId = new mongoose.Types.ObjectId();
  const createdBy = new mongoose.Types.ObjectId();
  const content = file.content;
  const sha256 = createHash('sha256').update(content).digest('hex');
  const bucket = getSourceFilesBucket();
  const filename = `${orgId}/${projectId}/${sourceVersionId}/${file.path}`;
  const upload = bucket.openUploadStream(filename, {
    metadata: {
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      path: file.path,
      sha256,
    },
  });
  await new Promise((resolve, reject) => {
    Readable.from(content).pipe(upload).on('finish', resolve).on('error', reject);
  });
  await insertSourceVersion({
    orgId,
    projectId,
    sourceVersionId: String(sourceVersionId),
    exclusionRulesetId: EXCLUSION_RULESET_ID,
    createdBy: String(createdBy),
    fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
  });
  await insertSourceFiles({
    orgId,
    projectId,
    sourceVersionId: String(sourceVersionId),
    createdBy: String(createdBy),
    files: [
      {
        path: file.path,
        sha256,
        byteLength: content.length,
        kind: file.path.endsWith('.md') ? 'doc' : 'code',
        gridFsId: upload.id,
        excludedFromGraph: false,
        exclusionReason: null,
      },
    ],
  });
  const { job } = await insertPendingJob({
    orgId,
    projectId,
    jobType: 'ingest',
    sourceVersionId,
    createdBy,
  });
  job.jobStatus = 'running';
  job.workerId = 'w-s3-extra';
  job.stageCheckpoint = {
    lastCompletedStage: 'exclude_apply',
    cursor: null,
    updatedAt: new Date(),
  };
  await job.save();
  return { orgId, projectId, sourceVersionId, job };
}

/**
 * @param {object} job Job.
 * @returns {object}
 */
function createWorkerContext(job) {
  return {
    job,
    stageCheckpoint: job.stageCheckpoint ?? null,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
    async recordEvent() {},
    async saveCheckpoint(checkpoint) {
      job.stageCheckpoint = {
        lastCompletedStage: checkpoint.lastCompletedStage,
        cursor: checkpoint.cursor,
      };
    },
    async saveProgress() {},
    async isCancelRequested() {
      return false;
    },
  };
}

describe('s3MaterializeDocs extras', () => {
  beforeAll(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sage-s3-extra-'));
    process.env.WORKSPACE_ROOT = workspaceRoot;
    process.env.MONGODB_URI = TEST_APP_CONFIG.mongo.uri;
    process.env.JWT_ACCESS_TOKEN_SECRET = TEST_APP_CONFIG.auth.jwtAccessTokenSecret;
    process.env.NODE_ENV = 'test';
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
    await clearSourceFilesBucket();
    vi.restoreAllMocks();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterAll(async () => {
    await harness.afterAll();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('skips paths listed in carry.skipPaths', async () => {
    const seeded = await seedOneVersion({
      path: 'docs/skip-me.md',
      content: Buffer.from('# Skip\n'),
    });
    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.carry.skipPaths = new Set(['docs/skip-me.md']);
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };

    const result = await runMaterializeDocsStage(ctx);
    expect(result.outcome).toBe('completed');
    expect(
      await documents.countSectionsForVersion({
        orgId: seeded.orgId,
        projectId: seeded.projectId,
        sourceVersionId: seeded.sourceVersionId,
      }),
    ).toBe(0);
  });

  it('warns with DOCUMENT_PARSE_FAILED when reading the materialized doc fails', async () => {
    const seeded = await seedOneVersion({
      path: 'docs/broken.md',
      content: Buffer.from('# Broken\n'),
    });
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, encoding) => {
      if (String(filePath).endsWith('broken.md')) {
        throw new Error('forced read failure');
      }
      return readFile(filePath, encoding);
    });

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };

    const result = await runMaterializeDocsStage(ctx);
    expect(result.outcome).toBe('completed_with_warnings');
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'DOCUMENT_PARSE_FAILED', path: 'docs/broken.md' }),
    ]);
  });

  it('fails permanent when workspace ids cannot form a safe project path', async () => {
    const ctx = {
      scope: { orgId: '../x', projectId: 'p', sourceVersionId: 'v' },
      carry: { workspaceRoot },
      checkpoint: { lastCompletedStage: 'exclude_apply', cursor: null },
      counters: { filesProcessed: 0, filesFailed: 0, bytesProcessed: 0 },
      signal: { aborted: false },
      isCancelRequested: async () => false,
      noteFileProcessed() {},
      saveProgress: async () => {},
      saveInProgressCursor: async () => {},
      emitEvent: async () => {},
    };
    await expect(runMaterializeDocsStage(ctx)).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_UNSAFE',
      failureClass: 'permanent',
    });
  });

  it('fails temporary when workspace reset hits an ENOSPC IO error', async () => {
    const seeded = await seedOneVersion({
      path: 'a.js',
      content: Buffer.from('a'),
    });
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(
      Object.assign(new Error('no space left'), { code: 'ENOSPC' }),
    );

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };

    await expect(runMaterializeDocsStage(ctx)).rejects.toMatchObject({
      code: 'WORKSPACE_IO_ERROR',
      failureClass: 'temporary',
    });
  });

  it('fails permanent when workspace reset reports WORKSPACE_PATH_UNSAFE', async () => {
    const seeded = await seedOneVersion({
      path: 'a.js',
      content: Buffer.from('a'),
    });
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(
      Object.assign(new Error('unsafe'), { code: 'WORKSPACE_PATH_UNSAFE' }),
    );

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };

    await expect(runMaterializeDocsStage(ctx)).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_UNSAFE',
      failureClass: 'permanent',
    });
  });

  it('fails temporary when workspace reset throws a non-coded error', async () => {
    const seeded = await seedOneVersion({
      path: 'a.js',
      content: Buffer.from('a'),
    });
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('reset exploded'));

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };

    await expect(runMaterializeDocsStage(ctx)).rejects.toMatchObject({
      code: 'WORKSPACE_IO_ERROR',
      failureClass: 'temporary',
    });
  });

  it('flushes an intra-stage cursor when the materialize batch size is reached', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();
    const createdBy = new mongoose.Types.ObjectId();
    const files = [];
    for (let i = 0; i < WORKSPACE_MATERIALIZE_BATCH_SIZE; i += 1) {
      const filePath = `f${String(i).padStart(3, '0')}.js`;
      const content = Buffer.from(`// ${i}\n`);
      const sha256 = createHash('sha256').update(content).digest('hex');
      const bucket = getSourceFilesBucket();
      const filename = `${orgId}/${projectId}/${sourceVersionId}/${filePath}`;
      const upload = bucket.openUploadStream(filename, {
        metadata: {
          orgId: String(orgId),
          projectId: String(projectId),
          sourceVersionId: String(sourceVersionId),
          path: filePath,
          sha256,
        },
      });
      await new Promise((resolve, reject) => {
        Readable.from(content).pipe(upload).on('finish', resolve).on('error', reject);
      });
      files.push({
        path: filePath,
        sha256,
        byteLength: content.length,
        kind: 'code',
        gridFsId: upload.id,
        excludedFromGraph: false,
        exclusionReason: null,
      });
    }
    await insertSourceVersion({
      orgId,
      projectId,
      sourceVersionId: String(sourceVersionId),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(createdBy),
      fileCounts: { accepted: files.length, skipped: 0, excludedFromGraph: 0 },
    });
    await insertSourceFiles({
      orgId,
      projectId,
      sourceVersionId: String(sourceVersionId),
      createdBy: String(createdBy),
      files,
    });
    const { job } = await insertPendingJob({
      orgId,
      projectId,
      jobType: 'ingest',
      sourceVersionId,
      createdBy,
    });
    job.jobStatus = 'running';
    job.workerId = 'w-batch';
    job.stageCheckpoint = {
      lastCompletedStage: 'exclude_apply',
      cursor: null,
      updatedAt: new Date(),
    };
    await job.save();

    const cursors = [];
    const workerContext = createWorkerContext(job);
    const version = await loadSourceVersionForIngest({
      orgId,
      projectId,
      sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };
    ctx.saveInProgressCursor = async (cursor) => {
      cursors.push(cursor);
    };

    const result = await runMaterializeDocsStage(ctx);
    expect(result.outcome).toBe('completed');
    expect(cursors.length).toBeGreaterThanOrEqual(1);
    expect(cursors[0]).toEqual({ path: expect.any(String) });
  });

  it('fails permanent when a stored SourceFile path escapes the workspace', async () => {
    const seeded = await seedOneVersion({
      path: 'safe.js',
      content: Buffer.from('ok'),
    });
    await SourceFile.updateOne(
      { orgId: seeded.orgId, path: 'safe.js' },
      { $set: { path: '../escape.js' } },
    );

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };

    await expect(runMaterializeDocsStage(ctx)).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_UNSAFE',
      failureClass: 'permanent',
    });
  });
});
