/**
 * Integration tests for ingest S0–S2 against Mongo + GridFS.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { Job } from '../jobs/job.model.js';
import { JobEvent } from '../jobs/jobEvent.model.js';
import { insertPendingJob, listEventsForJob } from '../jobs/jobs.repository.js';
import {
  EXCLUSION_RULESET_ID,
  SourceFile,
  SourceVersion,
  clearSourceFilesBucket,
  getSourceFilesBucket,
  insertSourceFiles,
  insertSourceVersion,
} from '../sources/index.js';
import { GRIDFS_SOURCE_BUCKET } from '../sources/sources.constants.js';
import { runIngestJob } from './ingest.handler.js';
import { runStoreFilesStage, INGEST_MAX_FAILED_FILE_RATIO } from './stages/s1StoreFiles.js';
import { buildIngestStageContext } from './ingest.context.js';
import { loadSourceVersionForIngest } from './ingest.repository.js';

const harness = createMongoHarness({
  models: [Job, JobEvent, SourceVersion, SourceFile],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * Uploads bytes to GridFS and returns the file id.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   path: string,
 *   content: Buffer,
 *   sha256?: string,
 * }} input Upload fields.
 * @returns {Promise<import('mongoose').Types.ObjectId>}
 */
async function putGridFsFile(input) {
  const bucket = getSourceFilesBucket();
  const sha256 =
    input.sha256 ?? createHash('sha256').update(input.content).digest('hex');
  const filename = `${input.orgId}/${input.projectId}/${input.sourceVersionId}/${input.path}`;
  const upload = bucket.openUploadStream(filename, {
    metadata: {
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
      path: input.path,
      sha256,
    },
  });
  await new Promise((resolve, reject) => {
    Readable.from(input.content)
      .pipe(upload)
      .on('finish', resolve)
      .on('error', reject);
  });
  return upload.id;
}

/**
 * Seeds a version, files, GridFS objects, and a pending ingest job.
 * @param {{
 *   files?: Array<{ path: string, content?: Buffer, excludedFromGraph?: boolean, exclusionReason?: string | null, corruptHash?: boolean, skipGridFs?: boolean }>,
 *   orphanExtra?: boolean,
 * }} [options] Seed options.
 * @returns {Promise<object>}
 */
async function seedIngestFixture(options = {}) {
  const orgId = new mongoose.Types.ObjectId();
  const projectId = new mongoose.Types.ObjectId();
  const sourceVersionId = new mongoose.Types.ObjectId();
  const createdBy = new mongoose.Types.ObjectId();
  const fileSpecs = options.files ?? [
    { path: 'src/a.js', content: Buffer.from('export const a = 1;\n') },
    { path: 'src/b.js', content: Buffer.from('export const b = 2;\n') },
    {
      path: 'docs/readme.md',
      content: Buffer.from('# Hi\n'),
    },
  ];

  const storedFiles = [];
  for (const spec of fileSpecs) {
    const content = spec.content ?? Buffer.from(`// ${spec.path}\n`);
    const contentSha256 = createHash('sha256').update(content).digest('hex');
    let gridFsId = new mongoose.Types.ObjectId();
    if (!spec.skipGridFs) {
      gridFsId = await putGridFsFile({
        orgId: String(orgId),
        projectId: String(projectId),
        sourceVersionId: String(sourceVersionId),
        path: spec.path,
        content,
        sha256: spec.corruptHash
          ? createHash('sha256').update('wrong').digest('hex')
          : contentSha256,
      });
    }
    storedFiles.push({
      path: spec.path,
      sha256: contentSha256,
      byteLength: content.length,
      kind: spec.path.endsWith('.md') ? 'doc' : 'code',
      gridFsId,
      excludedFromGraph: spec.excludedFromGraph === true,
      exclusionReason: spec.exclusionReason ?? null,
    });
  }

  if (options.orphanExtra) {
    await putGridFsFile({
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      path: 'orphan/extra.js',
      content: Buffer.from('orphan\n'),
    });
  }

  await insertSourceVersion({
    orgId,
    projectId,
    sourceVersionId: String(sourceVersionId),
    exclusionRulesetId: EXCLUSION_RULESET_ID,
    createdBy: String(createdBy),
    fileCounts: {
      accepted: storedFiles.length,
      skipped: 0,
      excludedFromGraph: storedFiles.filter((f) => f.excludedFromGraph).length,
    },
  });
  await insertSourceFiles({
    orgId,
    projectId,
    sourceVersionId: String(sourceVersionId),
    createdBy: String(createdBy),
    files: storedFiles,
  });

  const { job } = await insertPendingJob({
    orgId,
    projectId,
    jobType: 'ingest',
    sourceVersionId,
    createdBy,
  });

  return { orgId, projectId, sourceVersionId, job, storedFiles };
}

/**
 * Builds a worker-like context for runIngestJob / stages.
 * @param {object} job Job document.
 * @param {object} [overrides] Overrides.
 * @returns {object}
 */
function createWorkerContext(job, overrides = {}) {
  const abortController = new AbortController();
  return {
    job,
    stageCheckpoint: job.stageCheckpoint ?? null,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: abortController.signal,
    abortController,
    async recordEvent(event) {
      const { appendJobEvent } = await import('../jobs/jobs.repository.js');
      await appendJobEvent({
        orgId: job.orgId,
        projectId: job.projectId,
        jobId: job._id,
        eventCode: event.eventCode,
        severity: event.severity,
        message: event.message,
        data: event.data ?? {},
        correlationId: job.correlationId ?? null,
      });
    },
    async saveCheckpoint(checkpoint) {
      const { saveJobCheckpoint } = await import('../../worker/jobClaim.js');
      await saveJobCheckpoint({
        jobId: job._id,
        workerId: job.workerId,
        checkpoint: {
          lastCompletedStage: checkpoint.lastCompletedStage,
          ...(Object.prototype.hasOwnProperty.call(checkpoint, 'cursor')
            ? { cursor: checkpoint.cursor }
            : {}),
        },
        currentStage: checkpoint.currentStage ?? checkpoint.lastCompletedStage,
      });
      job.stageCheckpoint = {
        lastCompletedStage: checkpoint.lastCompletedStage,
        cursor: checkpoint.cursor,
      };
      job.currentStage = checkpoint.currentStage ?? checkpoint.lastCompletedStage;
    },
    async saveProgress(progress) {
      const { saveJobProgress } = await import('../../worker/jobClaim.js');
      await saveJobProgress({
        jobId: job._id,
        workerId: job.workerId,
        progressCounters: {
          itemsProcessed: progress.itemsProcessed,
          itemsFailed: progress.itemsFailed,
          warningCount: progress.warningCount,
          excludedCount: progress.excludedCount,
        },
        currentStage: progress.currentStage,
        partialSuccess: progress.partialSuccess,
      });
    },
    async isCancelRequested() {
      return false;
    },
    ...overrides,
  };
}

describe('ingest S0–S2 integration', () => {
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

  it('runs S0→S2 then fails permanent at S3 placeholder with expected events and checkpoint', async () => {
    const seeded = await seedIngestFixture({
      files: [
        { path: 'src/a.js', content: Buffer.from('export const a = 1;\n') },
        {
          path: 'big/data.js',
          content: Buffer.alloc(1_048_577, 0x61),
          excludedFromGraph: true,
          exclusionReason: 'file_too_large',
        },
      ],
    });

    // Claim-like running state so saveCheckpoint/progress ownership matches.
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-ingest-1';
    await seeded.job.save();

    const workerContext = createWorkerContext(seeded.job);
    await expect(runIngestJob(workerContext)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      failureClass: 'permanent',
    });

    const fresh = await Job.findById(seeded.job._id).lean();
    expect(fresh.stageCheckpoint.lastCompletedStage).toBe('exclude_apply');
    expect(fresh.progressCounters.itemsProcessed).toBeGreaterThan(0);

    const events = await listEventsForJob(seeded.orgId, seeded.job._id);
    const messages = events.map((e) => e.message);
    expect(messages).toContain('Source received');
    expect(messages.some((m) => m.startsWith('Source validated'))).toBe(true);
    expect(messages.some((m) => m.startsWith('Project files identified'))).toBe(true);
    expect(messages.some((m) => m.startsWith('Exclusions applied'))).toBe(true);
  });

  it('resumes S1 from a path cursor without re-processing earlier files', async () => {
    const seeded = await seedIngestFixture({
      files: [
        { path: 'a.js', content: Buffer.from('a') },
        { path: 'b.js', content: Buffer.from('b') },
        { path: 'c.js', content: Buffer.from('c') },
      ],
    });
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-resume';
    seeded.job.stageCheckpoint = {
      lastCompletedStage: 'validate_upload',
      cursor: { lastPath: 'a.js' },
      updatedAt: new Date(),
    };
    seeded.job.currentStage = 'store_files';
    await seeded.job.save();

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({
      workerContext,
      origin: 'upload',
    });
    ctx.carry.sourceVersion = version;
    ctx.checkpoint = {
      lastCompletedStage: 'validate_upload',
      cursor: { lastPath: 'a.js' },
    };

    const result = await runStoreFilesStage(ctx);
    expect(result.outcome).toBe('completed');
    // a.js restored from cursor + b.js + c.js
    expect(ctx.counters.filesProcessed).toBe(3);
  });

  it('marks orphan GridFS objects without deleting bytes', async () => {
    const seeded = await seedIngestFixture({
      files: [{ path: 'src/a.js', content: Buffer.from('ok') }],
      orphanExtra: true,
    });
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-orphan';
    seeded.job.stageCheckpoint = {
      lastCompletedStage: 'validate_upload',
      cursor: null,
      updatedAt: new Date(),
    };
    await seeded.job.save();

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.checkpoint = { lastCompletedStage: 'validate_upload', cursor: null };

    await runStoreFilesStage(ctx);

    const db = mongoose.connection.db;
    const orphan = await db.collection(`${GRIDFS_SOURCE_BUCKET}.files`).findOne({
      filename: {
        $regex: `/${String(seeded.sourceVersionId)}/orphan/extra\\.js$`,
      },
    });
    expect(orphan).toBeTruthy();
    expect(orphan.metadata.orphanedAt).toBeInstanceOf(Date);
    expect(orphan.length).toBeGreaterThan(0);
  });

  it('fails S0 with user_action_required on an unsafe path', async () => {
    const seeded = await seedIngestFixture({
      files: [{ path: 'src/a.js', content: Buffer.from('ok') }],
    });
    await SourceFile.updateOne(
      { orgId: seeded.orgId, path: 'src/a.js' },
      { $set: { path: '../escape.js' } },
    );
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-unsafe';
    await seeded.job.save();

    await expect(runIngestJob(createWorkerContext(seeded.job))).rejects.toMatchObject({
      code: 'SOURCE_PATH_UNSAFE',
      failureClass: 'user_action_required',
    });
    const version = await SourceVersion.findById(seeded.sourceVersionId).lean();
    expect(version.versionLifecycle).toBe('failed');
  });

  it('counts a hash mismatch as failed and continues below the ratio', async () => {
    const seeded = await seedIngestFixture({
      files: [
        { path: 'a.js', content: Buffer.from('a') },
        { path: 'b.js', content: Buffer.from('b'), corruptHash: true },
        { path: 'c.js', content: Buffer.from('c') },
        { path: 'd.js', content: Buffer.from('d') },
        { path: 'e.js', content: Buffer.from('e') },
        { path: 'f.js', content: Buffer.from('f') },
        { path: 'g.js', content: Buffer.from('g') },
        { path: 'h.js', content: Buffer.from('h') },
        { path: 'i.js', content: Buffer.from('i') },
        { path: 'j.js', content: Buffer.from('j') },
        { path: 'k.js', content: Buffer.from('k') },
        { path: 'l.js', content: Buffer.from('l') },
        { path: 'm.js', content: Buffer.from('m') },
        { path: 'n.js', content: Buffer.from('n') },
        { path: 'o.js', content: Buffer.from('o') },
        { path: 'p.js', content: Buffer.from('p') },
        { path: 'q.js', content: Buffer.from('q') },
        { path: 'r.js', content: Buffer.from('r') },
        { path: 's.js', content: Buffer.from('s') },
        { path: 't.js', content: Buffer.from('t') },
      ],
    });
    // 1/20 = 0.05 — ratio is ">" so exactly 5% continues
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-corrupt';
    seeded.job.stageCheckpoint = {
      lastCompletedStage: 'validate_upload',
      updatedAt: new Date(),
    };
    await seeded.job.save();

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.checkpoint = { lastCompletedStage: 'validate_upload' };

    const result = await runStoreFilesStage(ctx);
    expect(result.outcome).toBe('completed_with_warnings');
    expect(ctx.counters.filesFailed).toBe(1);
    expect(1 / 20).toBeLessThanOrEqual(INGEST_MAX_FAILED_FILE_RATIO);
  });

  it('fails S1 as temporary when failed ratio exceeds the threshold', async () => {
    const seeded = await seedIngestFixture({
      files: [
        { path: 'a.js', content: Buffer.from('a'), corruptHash: true },
        { path: 'b.js', content: Buffer.from('b'), corruptHash: true },
      ],
    });
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-ratio';
    seeded.job.stageCheckpoint = {
      lastCompletedStage: 'validate_upload',
      updatedAt: new Date(),
    };
    await seeded.job.save();

    const workerContext = createWorkerContext(seeded.job);
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.checkpoint = { lastCompletedStage: 'validate_upload' };

    await expect(runStoreFilesStage(ctx)).rejects.toMatchObject({
      code: 'INGEST_TOO_MANY_FAILED_FILES',
      failureClass: 'temporary',
    });
  });

  it('persists a cursor when the signal aborts mid-S1', async () => {
    const seeded = await seedIngestFixture({
      files: [
        { path: 'a.js', content: Buffer.from('a') },
        { path: 'b.js', content: Buffer.from('b') },
        { path: 'c.js', content: Buffer.from('c') },
      ],
    });
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-abort';
    seeded.job.stageCheckpoint = {
      lastCompletedStage: 'validate_upload',
      updatedAt: new Date(),
    };
    await seeded.job.save();

    const workerContext = createWorkerContext(seeded.job);
    let processed = 0;
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });
    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.checkpoint = { lastCompletedStage: 'validate_upload' };
    ctx.isCancelRequested = async () => {
      processed += 1;
      return processed > 1;
    };

    await expect(runStoreFilesStage(ctx)).rejects.toMatchObject({
      code: 'INGEST_ABORTED',
    });
    const fresh = await Job.findById(seeded.job._id).lean();
    expect(fresh.stageCheckpoint.cursor?.lastPath).toBe('a.js');
    expect(fresh.currentStage).toBe('store_files');
  });

  it('aborts when the job org does not match the source version project scope', async () => {
    const seeded = await seedIngestFixture();
    const otherProject = new mongoose.Types.ObjectId();
    seeded.job.projectId = otherProject;
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-tenant';
    await seeded.job.save();

    await expect(runIngestJob(createWorkerContext(seeded.job))).rejects.toMatchObject({
      code: 'INGEST_SOURCE_VERSION_NOT_FOUND',
      failureClass: 'permanent',
    });
  });
});
