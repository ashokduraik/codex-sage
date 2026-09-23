/**
 * Document FTS adapter for project search.
 */
import { searchDocumentSections } from '../documents/index.js';
import { SEARCH_DOC_MAX_RESULTS } from './search.constants.js';
import { mapDocSearchItem } from './search.mapper.js';

/**
 * Runs scoped document FTS and maps hits to search items.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   sourceVersionId: string,
 *   knowledgeVersionId: string,
 *   q: string,
 *   limit?: number,
 * }} input Scope + query.
 * @param {{
 *   searchSections?: typeof searchDocumentSections,
 * }} [deps] Test seams.
 * @returns {Promise<object[]>}
 */
export async function searchProjectDocuments(input, deps = {}) {
  const searchSections = deps.searchSections ?? searchDocumentSections;
  const rows = await searchSections(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
    },
    { q: input.q, limit: input.limit ?? SEARCH_DOC_MAX_RESULTS },
  );
  return rows.map((row) => mapDocSearchItem(row, input.knowledgeVersionId)).filter(Boolean);
}
