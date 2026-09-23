/**
 * Unit tests for processing project-id resolution.
 */
import { describe, expect, it } from 'vitest';
import { resolveProcessingProjectId } from './resolveProcessingProjectId.js';

describe('resolveProcessingProjectId', () => {
  it('prefers the projectId query string', () => {
    const searchParams = new URLSearchParams('projectId=from-query');
    expect(
      resolveProcessingProjectId({
        pathname: '/projects/from-route',
        params: { id: 'from-params' },
        searchParams,
      }),
    ).toBe('from-query');
  });

  it('uses the project route when no query is present', () => {
    expect(
      resolveProcessingProjectId({
        pathname: '/projects/prj_atlas/sources',
        params: { id: 'prj_atlas' },
        searchParams: new URLSearchParams(),
      }),
    ).toBe('prj_atlas');
  });

  it('returns empty on Home and admin', () => {
    expect(
      resolveProcessingProjectId({
        pathname: '/',
        params: {},
        searchParams: new URLSearchParams(),
      }),
    ).toBe('');
    expect(
      resolveProcessingProjectId({
        pathname: '/processing',
        params: {},
        searchParams: new URLSearchParams(),
      }),
    ).toBe('');
  });
});
