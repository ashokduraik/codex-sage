/**
 * Unit tests for assertKnowledgeReadable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertKnowledgeReadable } from '../../../src/modules/knowledge/knowledge.js';

describe('assertKnowledgeReadable', () => {
  const findProject = vi.fn();
  const hasWriterLock = vi.fn();

  beforeEach(() => {
    findProject.mockReset();
    hasWriterLock.mockReset();
  });

  it('denies when the project is missing', async () => {
    findProject.mockResolvedValue(null);
    const result = await assertKnowledgeReadable(
      { orgId: 'o1', projectId: 'p1' },
      { findProject, hasWriterLock },
    );
    expect(result).toMatchObject({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' });
  });

  it('denies when knowledgeHealth is failed or there is no pointer', async () => {
    findProject.mockResolvedValue({
      lifecycleStatus: 'failed',
      knowledgeHealth: 'failed',
      currentKnowledgeVersionId: 'kv1',
    });
    expect(
      await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' }, { findProject, hasWriterLock }),
    ).toMatchObject({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' });

    findProject.mockResolvedValue({
      lifecycleStatus: 'processing',
      knowledgeHealth: 'none',
      currentKnowledgeVersionId: null,
    });
    expect(
      await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' }, { findProject, hasWriterLock }),
    ).toMatchObject({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' });
  });

  it('queues when updating or a writer lock is held', async () => {
    findProject.mockResolvedValue({
      lifecycleStatus: 'updating',
      knowledgeHealth: 'updating',
      currentKnowledgeVersionId: 'kv1',
    });
    hasWriterLock.mockResolvedValue(false);
    expect(
      await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' }, { findProject, hasWriterLock }),
    ).toMatchObject({ action: 'queue', code: 'KNOWLEDGE_UPDATING' });

    findProject.mockResolvedValue({
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
      currentKnowledgeVersionId: 'kv1',
    });
    hasWriterLock.mockResolvedValue(true);
    expect(
      await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' }, { findProject, hasWriterLock }),
    ).toMatchObject({ action: 'queue', code: 'KNOWLEDGE_UPDATING' });
  });

  it('allows ready and partially_available when no writer is active', async () => {
    hasWriterLock.mockResolvedValue(false);
    findProject.mockResolvedValue({
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
      currentKnowledgeVersionId: 'kv1',
    });
    expect(
      await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' }, { findProject, hasWriterLock }),
    ).toEqual({ action: 'allow', knowledgeVersionId: 'kv1' });

    findProject.mockResolvedValue({
      lifecycleStatus: 'partially_available',
      knowledgeHealth: 'partially_available',
      currentKnowledgeVersionId: 'kv2',
    });
    expect(
      await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' }, { findProject, hasWriterLock }),
    ).toEqual({ action: 'allow', knowledgeVersionId: 'kv2' });
  });

  it('denies archived projects', async () => {
    findProject.mockResolvedValue({
      lifecycleStatus: 'archived',
      knowledgeHealth: 'ready',
      currentKnowledgeVersionId: 'kv1',
    });
    expect(
      await assertKnowledgeReadable({ orgId: 'o1', projectId: 'p1' }, { findProject, hasWriterLock }),
    ).toMatchObject({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' });
  });
});
