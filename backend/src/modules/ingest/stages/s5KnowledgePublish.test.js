/**
 * Unit tests for S5 and S6 stages.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publishKnowledgeVersion = vi.fn();
const findProjectById = vi.fn();
const transitionLifecycle = vi.fn();

vi.mock('../../knowledge/knowledge.publish.js', () => ({
  publishKnowledgeVersion: (...args) => publishKnowledgeVersion(...args),
}));

vi.mock('../../projects/index.js', () => ({
  findProjectById: (...args) => findProjectById(...args),
  transitionLifecycle: (...args) => transitionLifecycle(...args),
}));

import { runKnowledgePublishStage } from '../stages/s5KnowledgePublish.js';
import {
  lifecycleStatusForPublishedHealth,
  runFinalizeStage,
} from '../stages/s6Finalize.js';
import { createIngestCounters } from '../ingest.counters.js';

describe('s5KnowledgePublish', () => {
  beforeEach(() => {
    publishKnowledgeVersion.mockReset();
  });

  it('reads graphIdentity from checkpoint cursor and publishes', async () => {
    publishKnowledgeVersion.mockResolvedValue({
      knowledgeVersionId: 'kv1',
      publishedHealth: 'ready',
      excludedFileCount: 0,
      outcome: 'completed',
    });
    const ctx = {
      scope: {
        orgId: 'o1',
        projectId: 'p1',
        sourceVersionId: 'v1',
        correlationId: 'c1',
      },
      checkpoint: {
        cursor: {
          graphIdentity: {
            graphHash: 'h',
            indexedAt: 't',
            sourceVersionId: 'v1',
            indexedFileCount: 1,
            skippedFileCount: 0,
            mode: 'indexAll',
          },
        },
      },
      carry: {},
      counters: createIngestCounters(),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      saveProgress: vi.fn().mockResolvedValue(undefined),
      logger: {},
    };

    const result = await runKnowledgePublishStage(ctx);
    expect(result.outcome).toBe('completed');
    expect(ctx.carry.knowledgeVersionId).toBe('kv1');
    expect(publishKnowledgeVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        graphIdentity: expect.objectContaining({ graphHash: 'h' }),
      }),
    );
  });
});

describe('s6Finalize', () => {
  beforeEach(() => {
    findProjectById.mockReset();
    transitionLifecycle.mockReset();
  });

  it('maps published health to lifecycle status', () => {
    expect(lifecycleStatusForPublishedHealth('ready')).toBe('knowledge_ready');
    expect(lifecycleStatusForPublishedHealth('partially_available')).toBe(
      'partially_available',
    );
  });

  it('transitions processing to knowledge_ready with knowledgeHealth', async () => {
    findProjectById.mockResolvedValue({ lifecycleStatus: 'processing' });
    transitionLifecycle.mockResolvedValue({});
    const ctx = {
      scope: { orgId: 'o1', projectId: 'p1' },
      carry: {
        knowledgeVersionId: 'kv1',
        publishedHealth: 'ready',
        excludedFileCount: 0,
      },
      counters: createIngestCounters(),
      emitEvent: vi.fn().mockResolvedValue(undefined),
      saveProgress: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runFinalizeStage(ctx);
    expect(result.outcome).toBe('completed');
    expect(transitionLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'processing',
        to: 'knowledge_ready',
        source: 'worker',
        knowledgeVersionId: 'kv1',
        knowledgeHealth: 'ready',
      }),
    );
  });
});
