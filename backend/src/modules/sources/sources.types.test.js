/**
 * Unit tests for source-version list DTO mapping.
 */
import { describe, expect, it } from 'vitest';
import { mapSourceVersionToListDto } from './sources.types.js';

describe('mapSourceVersionToListDto', () => {
  it('maps ids and file counts with null-safe fallbacks', () => {
    expect(
      mapSourceVersionToListDto({
        _id: '665a00000000000000000001',
        origin: 'upload',
        versionLifecycle: 'accepted',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ).toEqual({
      id: '665a00000000000000000001',
      origin: 'upload',
      versionLifecycle: 'accepted',
      fileCounts: { accepted: 0, skipped: 0, excludedFromGraph: 0 },
      jobId: null,
      commitSha: null,
      branch: null,
      createdBy: null,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
  });
});
