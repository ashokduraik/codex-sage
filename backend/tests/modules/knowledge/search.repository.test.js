/**
 * Unit tests for document FTS mapping.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchDocumentSections } = vi.hoisted(() => ({
  searchDocumentSections: vi.fn(),
}));

vi.mock('../../../src/modules/knowledge/documents.js', () => ({
  searchDocumentSections,
}));

import { searchProjectDocuments } from '../../../src/modules/knowledge/search.js';

describe('searchProjectDocuments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps FTS rows and drops incomplete sections', async () => {
    searchDocumentSections.mockResolvedValue([
      { _id: 'sec1', path: 'docs/a.md', heading: 'Refunds', text: 'Partial refunds' },
      { path: 'docs/missing-id.md', text: 'no id' },
    ]);

    const items = await searchProjectDocuments({
      orgId: 'o1',
      projectId: 'p1',
      sourceVersionId: 'sv1',
      knowledgeVersionId: 'kv1',
      q: 'refund',
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'doc', title: 'Refunds', id: 'kv1:doc:sec1' });
    expect(searchDocumentSections).toHaveBeenCalledWith({ orgId: 'o1', projectId: 'p1', sourceVersionId: 'sv1' }, { q: 'refund', limit: 15 });
  });
});
