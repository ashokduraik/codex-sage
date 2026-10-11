/**
 * Unit tests for change-summary mapping and latest-read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLatestChangeSummary, mapChangeSummaryDto, mapSummaryPaths } from '../../../src/modules/knowledge/changeSummary.js';

const { findProjectById, findKnowledgeVersionById, sourceChangeSummaryFindOne } = vi.hoisted(() => ({
  findProjectById: vi.fn(),
  findKnowledgeVersionById: vi.fn(),
  sourceChangeSummaryFindOne: vi.fn(),
}));

vi.mock('../../../src/modules/masters/index.js', () => ({
  findProjectById,
}));

vi.mock('../../../src/modules/knowledge/knowledge.js', () => ({
  findKnowledgeVersionById,
}));

vi.mock('../../../src/models/sourceChangeSummary.model.js', () => ({
  SourceChangeSummary: {
    findOne: sourceChangeSummaryFindOne,
  },
}));

/**
 * Chains findOne → sort → lean → exec for the latest-summary query.
 * @param {object | null} row Lean summary or null.
 */
function mockLatestSummary(row) {
  sourceChangeSummaryFindOne.mockReturnValue({
    sort: () => ({
      lean: () => ({
        exec: async () => row,
      }),
    }),
  });
}

describe('mapChangeSummaryDto', () => {
  it('maps changed → modified and leaves impact unknown', () => {
    const dto = mapChangeSummaryDto(
      {
        sourceVersionId: 'sv2',
        knowledgeVersionId: 'kv1',
        counts: { added: 2, changed: 3, removed: 1, unchanged: 9 },
        paths: {
          added: ['src/new.js'],
          changed: ['src/app.js'],
          removed: ['old.js'],
          unchanged: ['README.md'],
        },
      },
      '2026-09-12T10:00:00.000Z',
    );
    expect(dto.counts).toEqual({ added: 2, modified: 3, removed: 1 });
    expect(dto.paths.modified).toEqual([{ path: 'src/app.js', impact: null }]);
    expect(dto.impact).toEqual({
      apisChanged: null,
      workflowsChanged: null,
      documentationConflicts: 0,
    });
    expect(dto.conflicts).toEqual([]);
    expect(dto.publishedAt).toBe('2026-09-12T10:00:00.000Z');
    expect(mapSummaryPaths(null)).toEqual([]);
    expect(mapSummaryPaths(['', 'ok'])).toEqual([{ path: 'ok', impact: null }]);
  });
});

describe('loadLatestChangeSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws PROJECT_NOT_FOUND or CHANGE_SUMMARY_NOT_FOUND', async () => {
    findProjectById.mockResolvedValue(null);
    await expect(loadLatestChangeSummary({ orgId: 'o1', projectId: 'p1' })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });

    findProjectById.mockResolvedValue({ status: 'A' });
    mockLatestSummary(null);
    await expect(loadLatestChangeSummary({ orgId: 'o1', projectId: 'p1' })).rejects.toMatchObject({
      code: 'CHANGE_SUMMARY_NOT_FOUND',
    });
  });

  it('attaches publishedAt from the linked knowledge version', async () => {
    findProjectById.mockResolvedValue({ status: 'A' });
    mockLatestSummary({
      sourceVersionId: 'sv2',
      knowledgeVersionId: 'kv1',
      counts: { added: 1, changed: 0, removed: 0 },
      paths: { added: ['a.js'], changed: [], removed: [] },
    });
    findKnowledgeVersionById.mockResolvedValue({ publishedAt: new Date('2026-01-02T00:00:00.000Z') });

    const dto = await loadLatestChangeSummary({ orgId: 'o1', projectId: 'p1' });
    expect(dto.publishedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(dto.counts.added).toBe(1);
  });
});
