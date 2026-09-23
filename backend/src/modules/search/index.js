/**
 * Public surface of the project search module.
 */
export { searchRoutes } from './search.routes.js';
export { runProjectSearch, runProjectSearchFromQuery } from './search.service.js';
export { resolveSearchResultForChat } from './search.resolver.js';
export {
  SEARCH_QUERY_MIN_LEN,
  SEARCH_PAGE_SIZE,
  SEARCH_SNIPPET_MAX_CHARS,
  SEARCH_GRAPH_MAX_RESULTS,
  SEARCH_DOC_MAX_RESULTS,
  SEARCH_TYPES,
} from './search.constants.js';
export {
  encodeSearchResultId,
  parseSearchResultId,
  encodeOpaqueKey,
  decodeOpaqueKey,
} from './search.ids.js';
export { parseSearchTypes, parseSearchQuery, clampSearchLimit } from './search.schemas.js';
