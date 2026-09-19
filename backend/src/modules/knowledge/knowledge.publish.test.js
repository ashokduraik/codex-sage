/**
 * Unit tests for knowledge publish helpers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const countExcludedFromGraphFiles = vi.fn();
const findActiveKnowledgeVersionForSource = vi.fn();
const insertKnowledgeVersion = vi.fn();
const recordAuditEvent = vi.fn();

vi.mock('./knowledgeVersion.repository.js', () => ({
  countExcludedFromGraphFiles: (...args) => countExcludedFromGraphFiles(...args),
  findActiveKnowledgeVersionForSource: (...args) => findActiveKnowledgeVersionForSource(...args),
  insertKnowledgeVersion: (...args) => insertKnowledgeVersion(...args),
}));

vi.mock('../audit/index.js', () => ({
  recordAuditEvent: (...args) => recordAuditEvent(...args),
}));

import {
  publishKnowledgeVersion,
  resolvePublishedHealth,
  sanitizeGraphIdentityForPublish,
} from './knowledge.publish.js';

describe('knowledge.publish', () => {
  beforeEach(() => {
    countExcludedFromGraphFiles.mockReset();
    findActiveKnowledgeVersionForSource.mockReset();
    insertKnowledgeVersion.mockReset();
    recordAuditEvent.mockReset();
  });

  it('maps exclusions to partially_available and zero exclusions to ready', () => {
    expect(resolvePublishedHealth(0)).toBe('ready');
    expect(resolvePublishedHealth(3)).toBe('partially_available');
  });

  it('strips absolute graph paths from identity', () => {
    expect(
      sanitizeGraphIdentityForPublish({
        graphPath: '/tmp/ws/.codegraph',
        graphHash: 'abc',
        indexedAt: '2026-01-01T00:00:00.000Z',
        sourceVersionId: 'v1',
        indexedFileCount: 2,
        skippedFileCount: 1,
        mode: 'indexAll',
      }),
    ).toEqual({
      graphHash: 'abc',
      indexedAt: '2026-01-01T00:00:00.000Z',
      sourceVersionId: 'v1',
      indexedFileCount: 2,
      skippedFileCount: 1,
      mode: 'indexAll',
      graphDir: '.codegraph',
    });
  });

  it('fails permanently without graph identity', async () => {
    await expect(
      publishKnowledgeVersion({
        orgId: 'o1',
        projectId: 'p1',
        sourceVersionId: 'v1',
        graphIdentity: null,
      }),
    ).rejects.toMatchObject({
      code: 'INGEST_MISSING_GRAPH_IDENTITY',
      failureClass: 'permanent',
    });
  });

  it('inserts a KnowledgeVersion and audits completion', async () => {
    countExcludedFromGraphFiles.mockResolvedValue(2);
    findActiveKnowledgeVersionForSource.mockResolvedValue(null);
    insertKnowledgeVersion.mockResolvedValue({ _id: 'kv1' });
    recordAuditEvent.mockResolvedValue(undefined);

    const result = await publishKnowledgeVersion({
      orgId: 'o1',
      projectId: 'p1',
      sourceVersionId: 'v1',
      correlationId: 'c1',
      graphIdentity: {
        graphHash: 'h1',
        indexedAt: '2026-01-01T00:00:00.000Z',
        sourceVersionId: 'v1',
        indexedFileCount: 1,
        skippedFileCount: 2,
        mode: 'indexAll',
      },
    });

    expect(result).toMatchObject({
      knowledgeVersionId: 'kv1',
      publishedHealth: 'partially_available',
      excludedFileCount: 2,
      reused: false,
      outcome: 'completed_with_warnings',
    });
    expect(insertKnowledgeVersion).toHaveBeenCalledOnce();
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'knowledge.completed' }),
      expect.anything(),
    );
  });

  it('reuses an existing row with matching graphHash', async () => {
    countExcludedFromGraphFiles.mockResolvedValue(0);
    findActiveKnowledgeVersionForSource.mockResolvedValue({
      _id: 'kv-existing',
      publishedHealth: 'ready',
      graphIdentity: { graphHash: 'h1' },
    });

    const result = await publishKnowledgeVersion({
      orgId: 'o1',
      projectId: 'p1',
      sourceVersionId: 'v1',
      graphIdentity: {
        graphHash: 'h1',
        indexedAt: '2026-01-01T00:00:00.000Z',
        sourceVersionId: 'v1',
        indexedFileCount: 1,
        skippedFileCount: 0,
        mode: 'indexAll',
      },
    });

    expect(result.reused).toBe(true);
    expect(result.knowledgeVersionId).toBe('kv-existing');
    expect(insertKnowledgeVersion).not.toHaveBeenCalled();
  });
});
