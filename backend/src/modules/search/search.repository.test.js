/**
 * Unit tests for document FTS mapping.
 */
import { describe, expect, it } from 'vitest';
import { searchProjectDocuments } from './search.repository.js';

describe('searchProjectDocuments', () => {
  it('maps FTS rows and drops incomplete sections', async () => {
    const items = await searchProjectDocuments(
      {
        orgId: 'o1',
        projectId: 'p1',
        sourceVersionId: 'sv1',
        knowledgeVersionId: 'kv1',
        q: 'refund',
      },
      {
        searchSections: async () => [
          { _id: 'sec1', path: 'docs/a.md', heading: 'Refunds', text: 'Partial refunds' },
          { path: 'docs/missing-id.md', text: 'no id' },
        ],
      },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'doc', title: 'Refunds', id: 'kv1:doc:sec1' });
  });
});
