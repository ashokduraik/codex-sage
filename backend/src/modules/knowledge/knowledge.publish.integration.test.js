/**
 * Integration tests for knowledge publish + finalize against Mongo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { AUDIT_MODELS, listAuditEventsForOrg } from '../audit/index.js';
import { Project } from '../projects/projects.model.js';
import { KnowledgeVersion } from './knowledgeVersion.model.js';
import { publishKnowledgeVersion } from './knowledge.publish.js';
import { assertKnowledgeReadable } from './knowledge.gate.js';
import { runFinalizeStage } from '../ingest/stages/s6Finalize.js';
import { SOURCE_FILE_STATE_STORED } from '../sources/sources.constants.js';
import { SourceFile } from '../sources/sourceFile.model.js';
import { createIngestCounters } from '../ingest/ingest.counters.js';

const harness = createMongoHarness({
  models: [...AUDIT_MODELS, Project, KnowledgeVersion, SourceFile],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('knowledge publish integration', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('publishes KnowledgeVersion, finalizes lifecycle, and allows the gate', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();

    await Project.create({
      _id: projectId,
      orgId,
      name: 'Publish fixture',
      description: '',
      lifecycleStatus: 'processing',
      knowledgeHealth: 'none',
      sourceConfig: { sourceType: 'upload' },
      counts: { sourceVersions: 1, files: 2, excludedFiles: 1, conversations: 0 },
      settings: {},
      createdBy: actor,
      updatedBy: actor,
    });

    await SourceFile.create([
      {
        orgId,
        projectId,
        sourceVersionId,
        path: 'a.js',
        sha256: 'a'.repeat(64),
        byteLength: 10,
        kind: 'code',
        gridFsId: new mongoose.Types.ObjectId(),
        excludedFromGraph: false,
        fileState: SOURCE_FILE_STATE_STORED,
        createdBy: actor,
        updatedBy: actor,
      },
      {
        orgId,
        projectId,
        sourceVersionId,
        path: 'big.js',
        sha256: 'b'.repeat(64),
        byteLength: 2_000_000,
        kind: 'code',
        gridFsId: new mongoose.Types.ObjectId(),
        excludedFromGraph: true,
        exclusionReason: 'file_too_large',
        fileState: SOURCE_FILE_STATE_STORED,
        createdBy: actor,
        updatedBy: actor,
      },
    ]);

    const published = await publishKnowledgeVersion({
      orgId: String(orgId),
      projectId: String(projectId),
      sourceVersionId: String(sourceVersionId),
      correlationId: 'corr-publish-1',
      graphIdentity: {
        graphHash: 'hash-1',
        indexedAt: new Date().toISOString(),
        sourceVersionId: String(sourceVersionId),
        indexedFileCount: 1,
        skippedFileCount: 1,
        mode: 'indexAll',
        graphPath: '/tmp/should-not-persist',
      },
    });

    expect(published.publishedHealth).toBe('partially_available');
    expect(published.excludedFileCount).toBe(1);

    const kv = await KnowledgeVersion.findById(published.knowledgeVersionId).lean();
    expect(kv.graphIdentity.graphDir).toBe('.codegraph');
    expect(kv.graphIdentity.graphPath).toBeUndefined();
    expect(kv.status).toBe('A');

    const ctx = {
      scope: { orgId: String(orgId), projectId: String(projectId) },
      carry: {
        knowledgeVersionId: published.knowledgeVersionId,
        publishedHealth: published.publishedHealth,
        excludedFileCount: published.excludedFileCount,
      },
      counters: createIngestCounters(),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      saveProgress: vi.fn().mockResolvedValue(undefined),
    };
    await runFinalizeStage(ctx);

    const project = await Project.findById(projectId).lean();
    expect(project.lifecycleStatus).toBe('partially_available');
    expect(project.knowledgeHealth).toBe('partially_available');
    expect(String(project.currentKnowledgeVersionId)).toBe(published.knowledgeVersionId);

    const gate = await assertKnowledgeReadable({
      orgId: String(orgId),
      projectId: String(projectId),
    });
    expect(gate).toEqual({
      action: 'allow',
      knowledgeVersionId: published.knowledgeVersionId,
    });

    const audits = await listAuditEventsForOrg(String(orgId), {
      action: 'knowledge.completed',
      limit: 10,
    });
    expect(audits.items.length).toBeGreaterThanOrEqual(1);
  });
});
