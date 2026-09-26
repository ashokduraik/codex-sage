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
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import * as documents from '../../../src/modules/knowledge/documents.js';
import { DocumentSection } from '../../../src/modules/knowledge/documents.js';
import { Job } from '../../../src/models/job.model.js';
import { insertPendingJob } from '../../../src/modules/masters/jobs.helper.js';
import { SourceFile, SourceVersion, getSourceFilesBucket, insertSourceFiles, insertSourceVersion } from '../../../src/modules/knowledge/sources.js';
import { clearSourceFilesBucket } from '../../clearSourceFilesBucket.js';
import { EXCLUSION_RULESET_ID } from '../../../src/modules/knowledge/uploads.js';
import { buildIngestStageContext } from '../../../src/modules/knowledge/ingest.js';
import { loadSourceVersionForIngest } from '../../../src/modules/knowledge/ingest.js';
import { runMaterializeDocsStage, WORKSPACE_MATERIALIZE_BATCH_SIZE } from '../../../src/modules/knowledge/ingest.util.js';

let workspaceRoot;

const harness = createMongoHarness({
  models: [Job, SourceVersion, SourceFile, DocumentSection],
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

  it('keeps skipPaths on disk, copies prior sections, and deletes removed paths', async () => {
    const seeded = await seedOneVersion({
      path: 'docs/keep.md',
      content: Buffer.from('# Keep\nunchanged\n'),
    });
    const priorVersionId = new mongoose.Types.ObjectId();
    await documents.insertDocumentSections({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: priorVersionId,
      path: 'docs/keep.md',
      sections: [
        {
          heading: 'Keep',
          startLine: 1,
          endLine: 2,
          text: 'unchanged',
          sectionIndex: 0,
        },
      ],
    });

    const workspacePath = path.join(workspaceRoot, String(seeded.orgId), String(seeded.projectId));
    await fs.mkdir(path.join(workspacePath, 'docs'), { recursive: true });
    await fs.writeFile(path.join(workspacePath, 'docs/keep.md'), '# Keep\nunchanged\n');
    await fs.writeFile(path.join(workspacePath, 'docs/gone.md'), '# Gone\n');

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.carry.skipPaths = new Set(['docs/keep.md']);
    ctx.carry.removedPaths = ['docs/gone.md'];
    ctx.carry.baseSourceVersionId = String(priorVersionId);
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };

    const result = await runMaterializeDocsStage(ctx);
    expect(result.outcome).toBe('completed');
    expect(await fs.readFile(path.join(workspacePath, 'docs/keep.md'), 'utf8')).toContain('unchanged');
    await expect(fs.access(path.join(workspacePath, 'docs/gone.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await documents.listSectionsForPath({
        orgId: seeded.orgId,
        projectId: seeded.projectId,
        sourceVersionId: seeded.sourceVersionId,
        path: 'docs/keep.md',
      }),
    ).toHaveLength(1);
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
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'DOCUMENT_PARSE_FAILED', path: 'docs/broken.md' })]);
  });

  it('fails permanent when workspace ids cannot form a safe project path', async () => {
    const ctx = {
      scope: { orgId: '../../../src/modules/x', projectId: 'p', sourceVersionId: 'v' },
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
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(Object.assign(new Error('no space left'), { code: 'ENOSPC' }));

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
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(Object.assign(new Error('unsafe'), { code: 'WORKSPACE_PATH_UNSAFE' }));

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
    await SourceFile.updateOne({ orgId: seeded.orgId, path: 'safe.js' }, { $set: { path: '../../../src/modules/escape.js' } });

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
