/**
 * Query-key builders for knowledge surfaces.
 */
import { describe, expect, it } from 'vitest';
import {
  changeSummaryQueryKey,
  projectSearchQueryKey,
  sourcePreviewQueryKey,
  knowledgeFacetQueryKey,
  knowledgeFacetsQueryKey,
  knowledgeHealthQueryKey,
} from '@/features/knowledge/api/knowledgeApi.js';

describe('knowledge query keys', () => {
  it('builds frozen keys including default preview range slots', () => {
    expect(knowledgeFacetsQueryKey(1)).toEqual(['projects', '1', 'knowledge', 'facets']);
    expect(knowledgeFacetQueryKey(1, 'symbols')).toEqual(['projects', '1', 'knowledge', 'symbols', '']);
    expect(knowledgeHealthQueryKey(1)).toEqual(['projects', '1', 'knowledge', 'health']);
    expect(projectSearchQueryKey(1, 'q', 'doc')).toEqual(['projects', '1', 'search', 'q', 'doc']);
    expect(sourcePreviewQueryKey(1, 'a.js')).toEqual(['projects', '1', 'files', 'a.js', null, null]);
    expect(changeSummaryQueryKey(1)).toEqual(['projects', '1', 'knowledge', 'updates', 'latest']);
  });
});
