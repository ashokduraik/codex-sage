/**
 * Named constants for project search (not env).
 */

/** Minimum search query length. */
export const SEARCH_QUERY_MIN_LEN = 2;

/** Default and max page size for search results. */
export const SEARCH_PAGE_SIZE = 25;

/** Result snippet character cap. */
export const SEARCH_SNIPPET_MAX_CHARS = 280;

/** Per-type CodeGraph cap before merge. */
export const SEARCH_GRAPH_MAX_RESULTS = 15;

/** Document FTS cap before merge. */
export const SEARCH_DOC_MAX_RESULTS = 15;

/** Supported search type tokens. */
export const SEARCH_TYPES = Object.freeze(['code', 'doc', 'symbol', 'workflow', 'api']);

/** Sort order for merged results (type then title). */
export const SEARCH_TYPE_ORDER = Object.freeze(['code', 'doc', 'symbol', 'workflow', 'api']);

/** Graph-backed type tokens. */
export const SEARCH_GRAPH_TYPES = Object.freeze(['code', 'symbol', 'workflow', 'api']);
