/**
 * Unit tests for knowledge publish helpers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeVersion } from '../../../src/models/knowledgeVersion.model.js';
import { SourceFile } from '../../../src/models/sourceFile.model.js';

const recordAuditEvent = vi.fn();

vi.mock('../../../src/modules/access/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    recordAuditEvent: (...args) => recordAuditEvent(...args),
  };
});

import { publishKnowledgeVersion, resolvePublishedHealth, sanitizeGraphIdentityForPublish } from '../../../src/modules/knowledge/knowledge.js';

const ORG_ID = '665f1c9d4b2a8e0012a4f010';
const PROJECT_ID = '665f1c9d4b2a8e0012a4f011';
const SOURCE_VERSION_ID = '665f1c9d4b2a8e0012a4f012';

describe('knowledge.publish', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        sourceVersionId: SOURCE_VERSION_ID,
        graphIdentity: null,
      }),
    ).rejects.toMatchObject({
      code: 'INGEST_MISSING_GRAPH_IDENTITY',
      failureClass: 'permanent',
    });
  });

  it('inserts a KnowledgeVersion and audits completion', async () => {
    vi.spyOn(SourceFile, 'countDocuments').mockReturnValue({
      exec: vi.fn().mockResolvedValue(2),
    });
    vi.spyOn(KnowledgeVersion, 'findOne').mockReturnValue({
      sort() {
        return this;
      },
      lean() {
        return this;
      },
      exec: vi.fn().mockResolvedValue(null),
    });
    const createSpy = vi.spyOn(KnowledgeVersion, 'create').mockResolvedValue({
      _id: 'kv1',
      toObject() {
        return { _id: 'kv1' };
      },
    });
    recordAuditEvent.mockResolvedValue(undefined);

    const result = await publishKnowledgeVersion({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      sourceVersionId: SOURCE_VERSION_ID,
      correlationId: 'c1',
      graphIdentity: {
        graphHash: 'h1',
        indexedAt: '2026-01-01T00:00:00.000Z',
        sourceVersionId: SOURCE_VERSION_ID,
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
    expect(createSpy).toHaveBeenCalledOnce();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'knowledge.completed' }), expect.anything());
  });

  it('reuses an existing row with matching graphHash', async () => {
    vi.spyOn(SourceFile, 'countDocuments').mockReturnValue({
      exec: vi.fn().mockResolvedValue(0),
    });
    vi.spyOn(KnowledgeVersion, 'findOne').mockReturnValue({
      sort() {
        return this;
      },
      lean() {
        return this;
      },
      exec: vi.fn().mockResolvedValue({
        _id: 'kv-existing',
        publishedHealth: 'ready',
        graphIdentity: { graphHash: 'h1' },
      }),
    });
    const createSpy = vi.spyOn(KnowledgeVersion, 'create');

    const result = await publishKnowledgeVersion({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      sourceVersionId: SOURCE_VERSION_ID,
      graphIdentity: {
        graphHash: 'h1',
        indexedAt: '2026-01-01T00:00:00.000Z',
        sourceVersionId: SOURCE_VERSION_ID,
        indexedFileCount: 1,
        skippedFileCount: 0,
        mode: 'indexAll',
      },
    });

    expect(result.reused).toBe(true);
    expect(result.knowledgeVersionId).toBe('kv-existing');
    expect(createSpy).not.toHaveBeenCalled();
  });
});
