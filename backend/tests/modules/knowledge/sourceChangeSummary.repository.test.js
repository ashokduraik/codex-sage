/**
 * Persistence tests for source change summaries.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { SourceChangeSummary } from '../../../src/models/sourceChangeSummary.model.js';
import {
  findChangeSummaryForVersion,
  findLatestComputedChangeSummary,
  upsertChangeSummary,
} from '../../../src/modules/knowledge/changeSummary.js';

const harness = createMongoHarness({
  models: [SourceChangeSummary],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('sourceChangeSummary.repository', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('upserts a computed summary and finds it by incoming version', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();
    const previousSourceVersionId = new mongoose.Types.ObjectId();

    await upsertChangeSummary({
      orgId,
      projectId,
      sourceVersionId,
      previousSourceVersionId,
      knowledgeVersionId: null,
      added: ['src/new.js'],
      removed: [],
      changed: ['src/app.js'],
      unchanged: ['README.md'],
      counts: { added: 1, removed: 0, changed: 1, unchanged: 1 },
    });

    const first = await findChangeSummaryForVersion({
      orgId,
      projectId,
      sourceVersionId,
    });
    expect(first?.diffStatus).toBe('computed');
    expect(first?.paths.unchanged).toEqual(['README.md']);

    await upsertChangeSummary({
      orgId,
      projectId,
      sourceVersionId,
      previousSourceVersionId,
      knowledgeVersionId: null,
      added: ['src/new.js', 'src/extra.js'],
      removed: [],
      changed: ['src/app.js'],
      unchanged: ['README.md'],
      counts: { added: 2, removed: 0, changed: 1, unchanged: 1 },
    });

    expect(await SourceChangeSummary.countDocuments({ orgId, projectId })).toBe(1);
    const updated = await findChangeSummaryForVersion({
      orgId,
      projectId,
      sourceVersionId,
    });
    expect(updated?.counts.added).toBe(2);
  });

  it('returns null for an unknown or invalid source version id', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    expect(
      await findChangeSummaryForVersion({
        orgId,
        projectId,
        sourceVersionId: 'not-an-id',
      }),
    ).toBeNull();
    expect(
      await findChangeSummaryForVersion({
        orgId,
        projectId,
        sourceVersionId: new mongoose.Types.ObjectId(),
      }),
    ).toBeNull();
  });

  it('returns the newest computed summary for a project', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const older = new mongoose.Types.ObjectId();
    const newer = new mongoose.Types.ObjectId();
    await upsertChangeSummary({
      orgId,
      projectId,
      sourceVersionId: older,
      added: ['old.js'],
      removed: [],
      changed: [],
      unchanged: [],
      counts: { added: 1, removed: 0, changed: 0, unchanged: 0 },
    });
    await upsertChangeSummary({
      orgId,
      projectId,
      sourceVersionId: newer,
      added: ['new.js'],
      removed: [],
      changed: [],
      unchanged: [],
      counts: { added: 1, removed: 0, changed: 0, unchanged: 0 },
    });
    const latest = await findLatestComputedChangeSummary({ orgId, projectId });
    expect(String(latest?.sourceVersionId)).toBe(String(newer));
  });
});
