/**
 * Unit tests for KnowledgeVersion repository helpers.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const countDocuments = vi.fn();
const findOne = vi.fn();
const create = vi.fn();

vi.mock('../../../src/models/sourceFile.model.js', () => ({
  SourceFile: {
    countDocuments: (...args) => countDocuments(...args),
  },
}));

vi.mock('../../../src/models/knowledgeVersion.model.js', () => ({
  KnowledgeVersion: {
    findOne: (...args) => findOne(...args),
    create: (...args) => create(...args),
  },
}));

import {
  countExcludedFromGraphFiles,
  findActiveKnowledgeVersionForSource,
  findKnowledgeVersionById,
  insertKnowledgeVersion,
} from '../../../src/modules/knowledge/knowledge.js';

describe('knowledgeVersion.repository', () => {
  beforeEach(() => {
    countDocuments.mockReset();
    findOne.mockReset();
    create.mockReset();
  });

  it('counts excluded stored files for a version', async () => {
    const exec = vi.fn().mockResolvedValue(4);
    countDocuments.mockReturnValue({ exec });
    await expect(
      countExcludedFromGraphFiles({
        orgId: 'o1',
        projectId: 'p1',
        sourceVersionId: 'v1',
      }),
    ).resolves.toBe(4);
    expect(countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ excludedFromGraph: true }),
    );
  });

  it('returns null for invalid knowledge version ids', async () => {
    await expect(
      findKnowledgeVersionById({
        orgId: 'o1',
        projectId: 'p1',
        knowledgeVersionId: 'not-an-id',
      }),
    ).resolves.toBeNull();
    await expect(
      findActiveKnowledgeVersionForSource({
        orgId: 'o1',
        projectId: 'p1',
        sourceVersionId: 'bad',
      }),
    ).resolves.toBeNull();
  });

  it('inserts a KnowledgeVersion and returns a lean object', async () => {
    create.mockResolvedValue({
      toObject: () => ({ _id: 'kv1', publishedHealth: 'ready' }),
    });
    const doc = await insertKnowledgeVersion({
      orgId: '6650f1a2c3d4e5f601020301',
      projectId: '6650f1a2c3d4e5f601020302',
      sourceVersionId: '6650f1a2c3d4e5f601020303',
      graphIdentity: {
        graphHash: 'h',
        indexedAt: 't',
        sourceVersionId: '6650f1a2c3d4e5f601020303',
        indexedFileCount: 1,
        skippedFileCount: 0,
        mode: 'indexAll',
        graphDir: '.codegraph',
      },
      publishedHealth: 'ready',
      excludedFileCount: 0,
    });
    expect(doc).toEqual({ _id: 'kv1', publishedHealth: 'ready' });
  });
});
