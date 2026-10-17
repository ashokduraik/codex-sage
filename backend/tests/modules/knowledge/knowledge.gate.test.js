/**
 * Unit tests for assertKnowledgeReadable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertKnowledgeReadable } from '../../../src/modules/knowledge/knowledge.js';

const { findProjectById, hasActiveProjectWriterLock } = vi.hoisted(() => ({
  findProjectById: vi.fn(),
  hasActiveProjectWriterLock: vi.fn(),
}));

vi.mock('../../../src/modules/masters/index.js', () => ({
  findProjectById,
}));

vi.mock('../../../src/worker/projectLock.js', () => ({
  hasActiveProjectWriterLock,
}));

describe('assertKnowledgeReadable', () => {
  beforeEach(() => {
    findProjectById.mockReset();
    hasActiveProjectWriterLock.mockReset();
  });

  it('denies when the project is missing', async () => {
    findProjectById.mockResolvedValue(null);
    const result = await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' });
    expect(result).toMatchObject({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' });
  });

  it('denies when knowledgeHealth is failed or there is no pointer', async () => {
    findProjectById.mockResolvedValue({
      lifecycleStatus: 'failed',
      knowledgeHealth: 'failed',
      currentKnowledgeVersionId: 'kv1',
    });
    expect(await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' })).toMatchObject({
      action: 'deny',
      code: 'KNOWLEDGE_UNAVAILABLE',
    });

    findProjectById.mockResolvedValue({
      lifecycleStatus: 'processing',
      knowledgeHealth: 'none',
      currentKnowledgeVersionId: null,
    });
    expect(await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' })).toMatchObject({
      action: 'deny',
      code: 'KNOWLEDGE_UNAVAILABLE',
    });
  });

  it('queues when updating or a writer lock is held', async () => {
    findProjectById.mockResolvedValue({
      lifecycleStatus: 'updating',
      knowledgeHealth: 'updating',
      currentKnowledgeVersionId: 'kv1',
    });
    hasActiveProjectWriterLock.mockResolvedValue(false);
    expect(await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' })).toMatchObject({
      action: 'queue',
      code: 'KNOWLEDGE_UPDATING',
    });

    findProjectById.mockResolvedValue({
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
      currentKnowledgeVersionId: 'kv1',
    });
    hasActiveProjectWriterLock.mockResolvedValue(true);
    expect(await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' })).toMatchObject({
      action: 'queue',
      code: 'KNOWLEDGE_UPDATING',
    });
  });

  it('allows ready and partially_available when no writer is active', async () => {
    hasActiveProjectWriterLock.mockResolvedValue(false);
    findProjectById.mockResolvedValue({
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
      currentKnowledgeVersionId: 'kv1',
    });
    expect(await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' })).toEqual({
      action: 'allow',
      knowledgeVersionId: 'kv1',
    });

    findProjectById.mockResolvedValue({
      lifecycleStatus: 'partially_available',
      knowledgeHealth: 'partially_available',
      currentKnowledgeVersionId: 'kv2',
    });
    expect(await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' })).toEqual({
      action: 'allow',
      knowledgeVersionId: 'kv2',
    });
  });

  it('denies archived projects', async () => {
    findProjectById.mockResolvedValue({
      lifecycleStatus: 'archived',
      knowledgeHealth: 'ready',
      currentKnowledgeVersionId: 'kv1',
    });
    expect(await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' })).toMatchObject({
      action: 'deny',
      code: 'KNOWLEDGE_UNAVAILABLE',
    });
  });
});
