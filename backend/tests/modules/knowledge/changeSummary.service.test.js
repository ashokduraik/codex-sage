/**
 * Unit tests for change-summary mapping and latest-read.
 */
import { describe, expect, it } from 'vitest';
import {
  loadLatestChangeSummary,
  mapChangeSummaryDto,
  mapSummaryPaths,
} from '../../../src/modules/knowledge/changeSummary.js';

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
  it('throws PROJECT_NOT_FOUND or CHANGE_SUMMARY_NOT_FOUND', async () => {
    await expect(
      loadLatestChangeSummary({ orgId: 'o1', projectId: 'p1' }, { findProject: async () => null }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(
      loadLatestChangeSummary(
        { orgId: 'o1', projectId: 'p1' },
        {
          findProject: async () => ({ status: 'A' }),
          findLatest: async () => null,
        },
      ),
    ).rejects.toMatchObject({ code: 'CHANGE_SUMMARY_NOT_FOUND' });
  });

  it('attaches publishedAt from the linked knowledge version', async () => {
    const dto = await loadLatestChangeSummary(
      { orgId: 'o1', projectId: 'p1' },
      {
        findProject: async () => ({ status: 'A' }),
        findLatest: async () => ({
          sourceVersionId: 'sv2',
          knowledgeVersionId: 'kv1',
          counts: { added: 1, changed: 0, removed: 0 },
          paths: { added: ['a.js'], changed: [], removed: [] },
        }),
        findKnowledgeVersion: async () => ({ publishedAt: new Date('2026-01-02T00:00:00.000Z') }),
      },
    );
    expect(dto.publishedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(dto.counts.added).toBe(1);
  });
});
