/**
 * Tests for the post-S0 source-diff hook.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { KnowledgeVersion } from '../knowledge/knowledgeVersion.model.js';
import { Project } from '../projects/projects.model.js';
import {
  EXCLUSION_RULESET_ID,
  SourceChangeSummary,
  SourceFile,
  SourceVersion,
  insertSourceFiles,
  insertSourceVersion,
} from '../sources/index.js';
import { applySourceDiffAfterValidate, hydrateSourceDiffCarry } from './applySourceDiff.js';

const harness = createMongoHarness({
  models: [Project, KnowledgeVersion, SourceVersion, SourceFile, SourceChangeSummary],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('applySourceDiffAfterValidate', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('skips the hook for reingest jobs', async () => {
    const ctx = {
      scope: {
        orgId: new mongoose.Types.ObjectId(),
        projectId: new mongoose.Types.ObjectId(),
        sourceVersionId: new mongoose.Types.ObjectId(),
      },
      carry: {},
    };
    await applySourceDiffAfterValidate(ctx, { jobType: 'reingest' });
    expect(ctx.carry.skipPaths).toBeUndefined();
  });

  it('marks all paths added when no knowledge version is published', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    await Project.create({
      _id: projectId,
      orgId,
      name: 'Diff First',
      sourceConfig: { sourceType: 'upload' },
      lifecycleStatus: 'processing',
      knowledgeHealth: 'none',
      createdBy: actor,
      updatedBy: actor,
    });
    await insertSourceVersion({
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(actor),
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    });
    await insertSourceFiles({
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      createdBy: String(actor),
      files: [
        {
          path: 'README.md',
          sha256: 'aaa',
          byteLength: 3,
          kind: 'doc',
          gridFsId: new mongoose.Types.ObjectId(),
          excludedFromGraph: false,
        },
      ],
    });

    const ctx = {
      scope: { orgId, projectId, sourceVersionId },
      carry: {},
    };
    await applySourceDiffAfterValidate(ctx, { jobType: 'ingest' });
    expect([...ctx.carry.skipPaths]).toEqual([]);
    expect(ctx.carry.changedPaths).toEqual(['README.md']);
    await applySourceDiffAfterValidate(ctx, { jobType: 'ingest' });
    expect(ctx.carry.changedPaths).toEqual(['README.md']);
    const stored = await SourceChangeSummary.findOne({ orgId, sourceVersionId }).exec();
    expect(stored?.paths.added).toEqual(['README.md']);
  });

  it('hydrates skipPaths from a persisted summary on resume', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();
    await SourceChangeSummary.create({
      orgId,
      projectId,
      sourceVersionId,
      previousSourceVersionId: new mongoose.Types.ObjectId(),
      counts: { added: 0, removed: 0, changed: 1, unchanged: 1 },
      paths: {
        added: [],
        removed: [],
        changed: ['src/app.js'],
        unchanged: ['README.md'],
      },
      computedAt: new Date(),
      diffStatus: 'computed',
    });
    const ctx = {
      scope: { orgId, projectId, sourceVersionId },
      carry: {},
    };
    await hydrateSourceDiffCarry(ctx, { jobType: 'ingest' });
    expect([...ctx.carry.skipPaths]).toEqual(['README.md']);
    expect(ctx.carry.changedPaths).toEqual(['src/app.js']);
  });

  it('does not hydrate carry for reingest jobs', async () => {
    const ctx = { scope: { orgId: 'o', projectId: 'p', sourceVersionId: 'v' }, carry: {} };
    await hydrateSourceDiffCarry(ctx, { jobType: 'reingest' });
    expect(ctx.carry.skipPaths).toBeUndefined();
  });

  it('diffs against the last published source version', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const publishedSourceVersionId = new mongoose.Types.ObjectId();
    const incomingSourceVersionId = new mongoose.Types.ObjectId();
    const knowledgeVersionId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();

    await Project.create({
      _id: projectId,
      orgId,
      name: 'Diff Published',
      sourceConfig: { sourceType: 'upload' },
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
      currentKnowledgeVersionId: knowledgeVersionId,
      createdBy: actor,
      updatedBy: actor,
    });
    await KnowledgeVersion.create({
      _id: knowledgeVersionId,
      orgId,
      projectId,
      sourceVersionId: publishedSourceVersionId,
      graphIdentity: {
        graphHash: 'h',
        indexedAt: new Date().toISOString(),
        sourceVersionId: String(publishedSourceVersionId),
        indexedFileCount: 1,
        skippedFileCount: 0,
        mode: 'indexAll',
        graphDir: '.codegraph',
      },
      publishedHealth: 'ready',
      excludedFileCount: 0,
    });
    for (const [versionId, files] of [
      [
        publishedSourceVersionId,
        [
          {
            path: 'README.md',
            sha256: 'same',
            byteLength: 4,
            kind: 'doc',
          },
          {
            path: 'gone.md',
            sha256: 'old',
            byteLength: 3,
            kind: 'doc',
          },
        ],
      ],
      [
        incomingSourceVersionId,
        [
          {
            path: 'README.md',
            sha256: 'same',
            byteLength: 4,
            kind: 'doc',
          },
          {
            path: 'src/app.js',
            sha256: 'new',
            byteLength: 3,
            kind: 'code',
          },
        ],
      ],
    ]) {
      await insertSourceVersion({
        orgId: String(orgId),
        projectId: String(projectId),
        sourceVersionId: String(versionId),
        exclusionRulesetId: EXCLUSION_RULESET_ID,
        createdBy: String(actor),
        fileCounts: { accepted: files.length, skipped: 0, excludedFromGraph: 0 },
      });
      await insertSourceFiles({
        orgId: String(orgId),
        projectId: String(projectId),
        sourceVersionId: String(versionId),
        createdBy: String(actor),
        files: files.map((file) => ({
          ...file,
          gridFsId: new mongoose.Types.ObjectId(),
          excludedFromGraph: false,
        })),
      });
    }

    const ctx = {
      scope: { orgId, projectId, sourceVersionId: incomingSourceVersionId },
      carry: {},
    };
    await applySourceDiffAfterValidate(ctx, { jobType: 'ingest' });
    expect([...ctx.carry.skipPaths]).toEqual(['README.md']);
    expect(ctx.carry.changedPaths.sort()).toEqual(['src/app.js']);
    expect(ctx.carry.removedPaths).toEqual(['gone.md']);
  });

  it('does not persist a skip summary when the published source is this version', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();
    const knowledgeVersionId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    await Project.create({
      _id: projectId,
      orgId,
      name: 'Same Version',
      sourceConfig: { sourceType: 'upload' },
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
      currentKnowledgeVersionId: knowledgeVersionId,
      createdBy: actor,
      updatedBy: actor,
    });
    await KnowledgeVersion.create({
      _id: knowledgeVersionId,
      orgId,
      projectId,
      sourceVersionId,
      graphIdentity: {
        graphHash: 'h',
        indexedAt: new Date().toISOString(),
        sourceVersionId: String(sourceVersionId),
        indexedFileCount: 0,
        skippedFileCount: 0,
        mode: 'indexAll',
        graphDir: '.codegraph',
      },
      publishedHealth: 'ready',
      excludedFileCount: 0,
    });
    const ctx = {
      scope: { orgId, projectId, sourceVersionId },
      carry: {},
    };
    await applySourceDiffAfterValidate(ctx, { jobType: 'ingest' });
    expect(ctx.carry.skipPaths).toBeUndefined();
    expect(await SourceChangeSummary.countDocuments({ orgId, sourceVersionId })).toBe(0);
  });
});
