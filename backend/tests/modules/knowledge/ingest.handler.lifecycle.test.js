/**
 * Unit tests for ingest job-start lifecycle and fail hook helpers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enterIngestLifecycleAtJobStart, markProjectKnowledgeFailed } from '../../../src/modules/knowledge/ingest.js';

const findProjectById = vi.fn();
const transitionLifecycle = vi.fn();
const recordAuditEvent = vi.fn();

vi.mock('../../../src/modules/masters/index.js', () => ({
  findProjectById: (...args) => findProjectById(...args),
  transitionLifecycle: (...args) => transitionLifecycle(...args),
}));

vi.mock('../../../src/modules/access/index.js', () => ({
  recordAuditEvent: (...args) => recordAuditEvent(...args),
}));

describe('enterIngestLifecycleAtJobStart', () => {
  beforeEach(() => {
    findProjectById.mockReset();
    transitionLifecycle.mockReset();
  });

  it('moves source_received to processing', async () => {
    findProjectById.mockResolvedValue({ lifecycleStatus: 'source_received' });
    await enterIngestLifecycleAtJobStart({ orgId: 'o1', projectId: 'p1' });
    expect(transitionLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'source_received',
        to: 'processing',
        source: 'worker',
      }),
    );
  });

  it('moves knowledge_ready to updating with knowledgeHealth updating', async () => {
    findProjectById.mockResolvedValue({
      lifecycleStatus: 'knowledge_ready',
      currentKnowledgeVersionId: 'kv1',
    });
    await enterIngestLifecycleAtJobStart({ orgId: 'o1', projectId: 'p1' });
    expect(transitionLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'knowledge_ready',
        to: 'updating',
        knowledgeHealth: 'updating',
        source: 'worker',
      }),
    );
  });

  it('is a no-op when already processing', async () => {
    findProjectById.mockResolvedValue({ lifecycleStatus: 'processing' });
    await enterIngestLifecycleAtJobStart({ orgId: 'o1', projectId: 'p1' });
    expect(transitionLifecycle).not.toHaveBeenCalled();
  });
});

describe('markProjectKnowledgeFailed', () => {
  beforeEach(() => {
    findProjectById.mockReset();
    transitionLifecycle.mockReset();
    recordAuditEvent.mockReset();
  });

  it('transitions processing to failed and audits', async () => {
    findProjectById.mockResolvedValue({ lifecycleStatus: 'processing' });
    transitionLifecycle.mockResolvedValue({});
    recordAuditEvent.mockResolvedValue(undefined);

    await markProjectKnowledgeFailed({
      orgId: 'o1',
      projectId: 'p1',
      sourceVersionId: 'v1',
      failureCode: 'CODEGRAPH_RECOVERY_EXHAUSTED',
      correlationId: 'c1',
    });

    expect(transitionLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'processing',
        to: 'failed',
        knowledgeHealth: 'failed',
        source: 'worker',
      }),
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'knowledge.failed' }), expect.anything());
  });
});
