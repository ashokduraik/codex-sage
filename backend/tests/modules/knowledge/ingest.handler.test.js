/**
 * Integration tests for ingest S0–S3 against Mongo + GridFS.
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
import { DocumentSection, countSectionsForVersion, listSectionsForPath } from '../../../src/modules/knowledge/documents.js';
import { Job } from '../../../src/models/job.model.js';
import { insertPendingJob } from '../../../src/modules/masters/jobs.helper.js';
import { listJobEvents } from '../../listJobEvents.js';
import { Project } from '../../../src/models/projects.model.js';
import { KnowledgeVersion } from '../../../src/models/knowledgeVersion.model.js';
import {
  SourceChangeSummary,
  SourceFile,
  SourceVersion,
  getSourceFilesBucket,
  insertSourceFiles,
  insertSourceVersion,
} from '../../../src/modules/knowledge/sources.js';
import { EXCLUSION_RULESET_ID } from '../../../src/modules/knowledge/uploads.js';
import { GRIDFS_SOURCE_BUCKET } from '../../../src/modules/knowledge/sources.js';
import { clearSourceFilesBucket } from '../../clearSourceFilesBucket.js';
import { runIngestJob } from '../../../src/modules/knowledge/ingest.js';
import { runStoreFilesStage, INGEST_MAX_FAILED_FILE_RATIO } from '../../../src/modules/knowledge/ingest.helper.js';
import { runMaterializeDocsStage } from '../../../src/modules/knowledge/ingest.util.js';
import { buildIngestStageContext } from '../../../src/modules/knowledge/ingest.js';
import { loadSourceVersionForIngest } from '../../../src/modules/knowledge/ingest.js';

let workspaceRoot;

const harness = createMongoHarness({
  models: [
    Job,
    SourceVersion,
    SourceFile,
    SourceChangeSummary,
    DocumentSection,
    Project,
    KnowledgeVersion,
  ],
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
    const lower = spec.path.toLowerCase();
    const kind =
      lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.txt')
        ? 'doc'
        : 'code';
    storedFiles.push({
      path: spec.path,
      sha256: contentSha256,
      byteLength: content.length,
      kind,
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

  await Project.create({
    _id: projectId,
    orgId,
    name: 'Ingest fixture',
    description: '',
    lifecycleStatus: 'source_received',
    knowledgeHealth: 'none',
    sourceConfig: { sourceType: 'upload' },
    counts: {
      sourceVersions: 1,
      files: storedFiles.length,
      excludedFiles: storedFiles.filter((f) => f.excludedFromGraph).length,
      conversations: 0,
    },
    settings: {},
    createdBy,
    updatedBy: createdBy,
  });

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
      const { appendJobEvent } = await import('../../../src/modules/masters/jobs.helper.js');
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
      const { saveJobCheckpoint } = await import('../../../src/worker/jobClaim.js');
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
      const { saveJobProgress } = await import('../../../src/worker/jobClaim.js');
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

describe('ingest S0–S3 integration', () => {
  beforeAll(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sage-ingest-'));
    process.env.WORKSPACE_ROOT = workspaceRoot;
    process.env.MONGODB_URI = TEST_APP_CONFIG.mongo.uri;
    process.env.JWT_ACCESS_TOKEN_SECRET = TEST_APP_CONFIG.auth.jwtAccessTokenSecret;
    process.env.NODE_ENV = 'test';
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
    await clearSourceFilesBucket();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterAll(async () => {
    await harness.afterAll();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('runs S0→S3 then enters processing; S4 may proceed with CodeGraph when available', async () => {
    const seeded = await seedIngestFixture({
      files: [
        { path: 'src/a.js', content: Buffer.from('export const a = 1;\n') },
        {
          path: 'docs/guide.md',
          content: Buffer.from('# Guide\nHello\n'),
        },
        {
          path: 'big/data.js',
          content: Buffer.alloc(1_048_577, 0x61),
          excludedFromGraph: true,
          exclusionReason: 'file_too_large',
        },
      ],
    });

    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-ingest-1';
    await seeded.job.save();

    const workerContext = createWorkerContext(seeded.job);
    // Truncate after materialize by completing that stage then asserting project moved.
    // Full S4 depends on CodeGraph; call stages S0–S3 via checkpoint resume stop:
    workerContext.stageCheckpoint = null;

    // Run only through materialize by temporarily swapping remaining stages after claim path:
    const { resolveStagesAfter, INGEST_STAGES } = await import('../../../src/modules/knowledge/ingest.js');
    const throughS3 = INGEST_STAGES.filter((s) =>
      [
        'validate_upload',
        'store_files',
        'exclude_apply',
        'materialize_docs',
      ].includes(s.name),
    );

    const { buildIngestStageContext } = await import('../../../src/modules/knowledge/ingest.js');
    const version = await loadSourceVersionForIngest({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
    });

    const { enterIngestLifecycleAtJobStart } = await import('../../../src/modules/knowledge/ingest.js');
    await enterIngestLifecycleAtJobStart({
      orgId: String(seeded.orgId),
      projectId: String(seeded.projectId),
      log: workerContext.log,
    });

    const projectAfterStart = await Project.findById(seeded.projectId).lean();
    expect(projectAfterStart.lifecycleStatus).toBe('processing');

    const ctx = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx.carry.sourceVersion = version;
    ctx.carry.workspaceRoot = workspaceRoot;

    for (const stage of throughS3) {
      ctx.setCurrentStage(stage.name);
      const stageResult = await stage.run(ctx);
      await ctx.saveCheckpoint({
        lastCompletedStage: stage.name,
        cursor: stageResult?.cursor ?? null,
      });
      ctx.checkpoint = {
        lastCompletedStage: stage.name,
        cursor: stageResult?.cursor ?? null,
      };
    }

    const fresh = await Job.findById(seeded.job._id).lean();
    expect(fresh.stageCheckpoint.lastCompletedStage).toBe('materialize_docs');
    expect(fresh.progressCounters.itemsProcessed).toBeGreaterThan(0);

    const events = await listJobEvents(seeded.orgId, seeded.job._id);
    const messages = events.map((e) => e.message);
    expect(messages).toContain('Source received');
    expect(messages.some((m) => m.startsWith('Source validated'))).toBe(true);
    expect(messages.some((m) => m.startsWith('Project files identified'))).toBe(true);
    expect(messages.some((m) => m.startsWith('Exclusions applied'))).toBe(true);
    expect(messages.some((m) => m.startsWith('Project files materialized'))).toBe(true);
    expect(messages.some((m) => m.startsWith('Documentation identified'))).toBe(true);

    const diskGuide = path.join(
      workspaceRoot,
      String(seeded.orgId),
      String(seeded.projectId),
      'docs',
      'guide.md',
    );
    expect(await fs.readFile(diskGuide, 'utf8')).toContain('# Guide');
    const sections = await listSectionsForPath({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
      path: 'docs/guide.md',
    });
    expect(sections.length).toBeGreaterThan(0);
    expect(sections[0].heading).toBe('Guide');

    // silence unused import warning in some linters
    expect(resolveStagesAfter('materialize_docs').map((s) => s.name)[0]).toBe(
      'codegraph_update',
    );
  });

  it('materializes code without DocumentSection rows and completes with zero docs', async () => {
    const seeded = await seedIngestFixture({
      files: [{ path: 'src/only.js', content: Buffer.from('export const x = 1;\n') }],
    });
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-s3-code';
    seeded.job.stageCheckpoint = {
      lastCompletedStage: 'exclude_apply',
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
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };

    const result = await runMaterializeDocsStage(ctx);
    expect(result.outcome).toBe('completed');
    expect(
      await countSectionsForVersion({
        orgId: seeded.orgId,
        projectId: seeded.projectId,
        sourceVersionId: seeded.sourceVersionId,
      }),
    ).toBe(0);
    expect(ctx.carry.workspacePath).toBe(
      path.join(workspaceRoot, String(seeded.orgId), String(seeded.projectId)),
    );
  });

  it('resumes S3 from a path cursor without duplicating sections', async () => {
    const seeded = await seedIngestFixture({
      files: [
        { path: 'a.js', content: Buffer.from('a') },
        { path: 'docs/one.md', content: Buffer.from('# One\n') },
        { path: 'docs/two.md', content: Buffer.from('# Two\n') },
      ],
    });
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-s3-resume';
    seeded.job.stageCheckpoint = {
      lastCompletedStage: 'exclude_apply',
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

    const firstCtx = buildIngestStageContext({ workerContext, origin: 'upload' });
    firstCtx.carry.sourceVersion = version;
    firstCtx.carry.workspaceRoot = workspaceRoot;
    firstCtx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };
    let seen = 0;
    firstCtx.isCancelRequested = async () => {
      seen += 1;
      return seen > 1;
    };
    await expect(runMaterializeDocsStage(firstCtx)).rejects.toMatchObject({
      code: 'INGEST_ABORTED',
    });
    const mid = await Job.findById(seeded.job._id).lean();
    expect(mid.stageCheckpoint.cursor?.path).toBeTruthy();

    const secondJob = await Job.findById(seeded.job._id);
    const secondCtx = buildIngestStageContext({
      workerContext: createWorkerContext(secondJob),
      origin: 'upload',
    });
    secondCtx.carry.sourceVersion = version;
    secondCtx.carry.workspaceRoot = workspaceRoot;
    secondCtx.checkpoint = {
      lastCompletedStage: 'exclude_apply',
      cursor: mid.stageCheckpoint.cursor,
    };
    const result = await runMaterializeDocsStage(secondCtx);
    expect(result.outcome).toBe('completed');

    const one = await listSectionsForPath({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
      path: 'docs/one.md',
    });
    const two = await listSectionsForPath({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
      path: 'docs/two.md',
    });
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(1);
  });

  it('soft-deletes prior sections on a fresh rematerialize of the same version', async () => {
    const seeded = await seedIngestFixture({
      files: [{ path: 'docs/a.md', content: Buffer.from('# First\n') }],
    });
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-s3-rerun';
    seeded.job.stageCheckpoint = {
      lastCompletedStage: 'exclude_apply',
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
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };
    await runMaterializeDocsStage(ctx);

    const ctx2 = buildIngestStageContext({ workerContext, origin: 'upload' });
    ctx2.carry.sourceVersion = version;
    ctx2.carry.workspaceRoot = workspaceRoot;
    ctx2.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };
    await runMaterializeDocsStage(ctx2);

    const active = await listSectionsForPath({
      orgId: seeded.orgId,
      projectId: seeded.projectId,
      sourceVersionId: seeded.sourceVersionId,
      path: 'docs/a.md',
    });
    expect(active).toHaveLength(1);
    const deleted = await DocumentSection.countDocuments({
      orgId: seeded.orgId,
      sourceVersionId: seeded.sourceVersionId,
      status: 'D',
    });
    expect(deleted).toBeGreaterThanOrEqual(1);
  });

  it('warns and continues when a GridFS object is missing', async () => {
    const seeded = await seedIngestFixture({
      files: [
        { path: 'docs/ok.md', content: Buffer.from('# Ok\n') },
        { path: 'docs/missing.md', content: Buffer.from('# Missing\n'), skipGridFs: true },
      ],
    });
    seeded.job.jobStatus = 'running';
    seeded.job.workerId = 'w-s3-missing';
    seeded.job.stageCheckpoint = {
      lastCompletedStage: 'exclude_apply',
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
    ctx.carry.workspaceRoot = workspaceRoot;
    ctx.checkpoint = { lastCompletedStage: 'exclude_apply', cursor: null };

    const result = await runMaterializeDocsStage(ctx);
    expect(result.outcome).toBe('completed_with_warnings');
    expect(result.warnings.some((w) => w.code === 'GRIDFS_READ_FAILED')).toBe(true);
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
