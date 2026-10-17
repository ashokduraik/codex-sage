/**
 * knowledge/search.js — merged resource file.
 */
import { z } from 'zod';
import { ApiError } from '../../platform/errors.js';
import { createCodegraphAdapter } from './codegraph.js';
import { searchDocumentSections } from './documents.js';
import { resolveProjectWorkspacePath } from './sources.js';
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { findProjectById, recordProjectActivity } from '../masters/index.js';
import { assertKnowledgeReadable, findKnowledgeVersionById } from './knowledge.js';

// --- from search/search.ids.js ---
/**
 * Stable search result ids and keyset cursors.
 */
/** Result snippet character cap. */
export const SEARCH_SNIPPET_MAX_CHARS = 280;

/** Sort order for merged results (type then title). */
export const SEARCH_TYPE_ORDER = Object.freeze(['code', 'doc', 'symbol', 'workflow', 'api']);

/**
 * Encodes a search result id for the current knowledge version.
 * @param {string} knowledgeVersionId Current knowledge version id.
 * @param {string} type Search type token.
 * @param {string} opaqueKey Type-specific lookup key.
 * @returns {string}
 */
export function encodeSearchResultId(knowledgeVersionId, type, opaqueKey) {
  return `${knowledgeVersionId}:${type}:${opaqueKey}`;
}

/**
 * Parses a search result id into version, type, and opaque key.
 * @param {unknown} resultId Stored result id.
 * @returns {{ knowledgeVersionId: string, type: string, opaqueKey: string } | null}
 */
export function parseSearchResultId(resultId) {
  if (typeof resultId !== 'string' || resultId.length === 0) {
    return null;
  }
  const firstSep = resultId.indexOf(':');
  const secondSep = resultId.indexOf(':', firstSep + 1);
  if (firstSep <= 0 || secondSep <= firstSep) {
    return null;
  }
  const knowledgeVersionId = resultId.slice(0, firstSep);
  const type = resultId.slice(firstSep + 1, secondSep);
  const opaqueKey = resultId.slice(secondSep + 1);
  if (!knowledgeVersionId || !type || !opaqueKey) {
    return null;
  }
  return { knowledgeVersionId, type, opaqueKey };
}

/**
 * Encodes path/name/line parts into an opaque key.
 * @param {Array<string | number | null | undefined>} parts Lookup parts.
 * @returns {string}
 */
export function encodeOpaqueKey(parts) {
  return parts.map((part) => encodeURIComponent(String(part ?? ''))).join('|');
}

/**
 * Decodes an opaque key back into parts.
 * @param {string} opaqueKey Encoded key.
 * @returns {string[]}
 */
export function decodeOpaqueKey(opaqueKey) {
  if (typeof opaqueKey !== 'string' || opaqueKey.length === 0) {
    return [];
  }
  return opaqueKey.split('|').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

/**
 * Truncates a snippet to the named character cap.
 * @param {unknown} text Candidate text.
 * @returns {string}
 */
export function truncateSnippet(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SEARCH_SNIPPET_MAX_CHARS) {
    return collapsed;
  }
  return collapsed.slice(0, SEARCH_SNIPPET_MAX_CHARS);
}

/**
 * Encodes a keyset cursor from the last returned item.
 * @param {{ type: string, title: string, id: string }} item Last item.
 * @returns {string}
 */
export function encodeSearchCursor(item) {
  return Buffer.from(JSON.stringify({ type: item.type, title: item.title, id: item.id }), 'utf8').toString('base64url');
}

/**
 * Decodes a keyset cursor.
 * @param {unknown} cursor Opaque cursor.
 * @returns {{ type: string, title: string, id: string } | null}
 */
export function decodeSearchCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.type !== 'string' || typeof parsed.title !== 'string' || typeof parsed.id !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Compares two search items for type-then-title sort.
 * @param {{ type: string, title: string, id: string }} left Left item.
 * @param {{ type: string, title: string, id: string }} right Right item.
 * @returns {number}
 */
export function compareSearchItems(left, right) {
  const leftType = SEARCH_TYPE_ORDER.indexOf(left.type);
  const rightType = SEARCH_TYPE_ORDER.indexOf(right.type);
  if (leftType !== rightType) {
    return leftType - rightType;
  }
  const titleCmp = left.title.localeCompare(right.title);
  if (titleCmp !== 0) {
    return titleCmp;
  }
  return left.id.localeCompare(right.id);
}

/**
 * True when `item` sorts after the cursor (exclusive).
 * @param {{ type: string, title: string, id: string }} item Candidate.
 * @param {{ type: string, title: string, id: string } | null} cursor Decoded cursor.
 * @returns {boolean}
 */
export function isAfterSearchCursor(item, cursor) {
  if (!cursor) {
    return true;
  }
  return compareSearchItems(item, cursor) > 0;
}

// --- from search/search.schemas.js ---
/**
 * Query parsing for GET /knowledge/search/run/:projectId.
 */
/** Minimum search query length. */
export const SEARCH_QUERY_MIN_LEN = 2;

/** Default and max page size for search results. */
export const SEARCH_PAGE_SIZE = 25;

/** Supported search type tokens. */
export const SEARCH_TYPES = Object.freeze(['code', 'doc', 'symbol', 'workflow', 'api']);

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
export function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    details.push({
      path: issue.path.join('.') || 'query',
      message: issue.message,
    });
  }
  return details;
}

/**
 * Parses the `types` query token list.
 * @param {unknown} raw Raw query value.
 * @returns {string[]}
 * @throws {ApiError} When a token is unknown.
 */
export function parseSearchTypes(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return [...SEARCH_TYPES];
  }
  const tokens = String(raw)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'types', message: 'types must include at least one known token' }],
    });
  }
  const unknown = tokens.filter((token) => !SEARCH_TYPES.includes(token));
  if (unknown.length > 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: unknown.map((token) => ({
        path: 'types',
        message: `unknown type token: ${token}`,
      })),
    });
  }
  return [...new Set(tokens)];
}

/**
 * Clamps search page size to SEARCH_PAGE_SIZE.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampSearchLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return SEARCH_PAGE_SIZE;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return SEARCH_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), SEARCH_PAGE_SIZE);
}

/**
 * Parses and validates the search query string.
 * @param {unknown} query Fastify query object.
 * @returns {{ q: string, types: string[], cursor?: string, limit: number }}
 * @throws {ApiError}
 */
export function parseSearchQuery(query) {
  const searchQuerySchema = z.object({
    q: z.string().trim().min(SEARCH_QUERY_MIN_LEN),
    types: z.string().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().optional(),
  });
  const parsed = searchQuerySchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  return {
    q: parsed.data.q,
    types: parseSearchTypes(parsed.data.types),
    cursor: parsed.data.cursor,
    limit: clampSearchLimit(parsed.data.limit),
  };
}

// --- from search/search.mapper.js ---
/**
 * Maps document and CodeGraph hits to unified search items.
 */
/**
 * Unwraps a CodeGraph search hit that may nest the node.
 * @param {object} raw Library row.
 * @returns {object | null}
 */
export function unwrapGraphNode(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const node = raw.node && typeof raw.node === 'object' ? raw.node : raw;
  return node && typeof node === 'object' ? node : null;
}

/**
 * True when a graph node is a file-like row (not a symbol).
 * @param {object | null} node Graph node.
 * @returns {boolean}
 */
export function isFileLikeNode(node) {
  if (!node) {
    return false;
  }
  const kind = typeof node.kind === 'string' ? node.kind.toLowerCase() : '';
  return kind === 'file' || kind === 'module' || kind === 'sourcefile';
}

/**
 * Maps a document section FTS row to a search item.
 * @param {object} section Lean DocumentSection.
 * @param {string} knowledgeVersionId Current version id.
 * @returns {object | null}
 */
export function mapDocSearchItem(section, knowledgeVersionId) {
  if (!section || typeof section !== 'object') {
    return null;
  }
  const path = typeof section.path === 'string' ? section.path : null;
  const sectionId = section._id ? String(section._id) : null;
  if (!path || !sectionId) {
    return null;
  }
  const title = typeof section.heading === 'string' && section.heading.trim() ? section.heading.trim() : path;
  return {
    id: encodeSearchResultId(knowledgeVersionId, 'doc', sectionId),
    type: 'doc',
    title,
    snippet: truncateSnippet(section.text),
    sourceRef: {
      path,
      startLine: Number(section.startLine) || undefined,
      endLine: Number(section.endLine) || undefined,
      sectionId,
    },
    score: null,
  };
}

/**
 * Maps a symbol/code graph node to a search item.
 * @param {object} raw Library row.
 * @param {string} knowledgeVersionId Current version id.
 * @param {'symbol' | 'code'} type Result type.
 * @returns {object | null}
 */
export function mapGraphSearchItem(raw, knowledgeVersionId, type) {
  const node = unwrapGraphNode(raw);
  if (!node) {
    return null;
  }
  const name = typeof node.name === 'string' ? node.name : null;
  const path = typeof node.filePath === 'string' ? node.filePath : null;
  if (!name || !path) {
    return null;
  }
  const startLine = Number(node.startLine) || 0;
  const endLine = Number(node.endLine) || startLine || undefined;
  const opaqueKey = encodeOpaqueKey([path, name, startLine]);
  const snippetSource = typeof raw.snippet === 'string' ? raw.snippet : typeof node.signature === 'string' ? node.signature : name;
  return {
    id: encodeSearchResultId(knowledgeVersionId, type, opaqueKey),
    type,
    title: name,
    snippet: truncateSnippet(snippetSource),
    sourceRef: {
      path,
      startLine: startLine || undefined,
      endLine: endLine || undefined,
    },
    score: null,
  };
}

/**
 * Maps a routing-manifest or route node to a search item.
 * @param {object} raw Library row.
 * @param {string} knowledgeVersionId Current version id.
 * @param {number} index Fallback salt.
 * @returns {object | null}
 */
export function mapApiSearchItem(raw, knowledgeVersionId, index) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.url === 'string') {
    const path = typeof raw.handlerFile === 'string' ? raw.handlerFile : '';
    const startLine = Number(raw.handlerLine) || 0;
    const title = raw.url;
    return {
      id: encodeSearchResultId(knowledgeVersionId, 'api', encodeOpaqueKey([title, path, startLine, raw.handler ?? index])),
      type: 'api',
      title,
      snippet: truncateSnippet(typeof raw.handler === 'string' ? raw.handler : title),
      sourceRef: path ? { path, startLine: startLine || undefined } : { path: title },
      score: null,
    };
  }
  const path = typeof raw.filePath === 'string' ? raw.filePath : null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!path || !name) {
    return null;
  }
  const startLine = Number(raw.startLine) || 0;
  return {
    id: encodeSearchResultId(knowledgeVersionId, 'api', encodeOpaqueKey([name, path, startLine])),
    type: 'api',
    title: name,
    snippet: truncateSnippet(name),
    sourceRef: { path, startLine: startLine || undefined },
    score: null,
  };
}

/**
 * Maps a workflow node when the library exposes one.
 * @param {object} raw Library row.
 * @param {string} knowledgeVersionId Current version id.
 * @param {number} index Fallback salt.
 * @returns {object | null}
 */
export function mapWorkflowSearchItem(raw, knowledgeVersionId, index) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const title = typeof raw.title === 'string' ? raw.title : typeof raw.name === 'string' ? raw.name : null;
  const path = typeof raw.path === 'string' ? raw.path : typeof raw.filePath === 'string' ? raw.filePath : '';
  if (!title) {
    return null;
  }
  const startLine = Number(raw.startLine) || 0;
  return {
    id: encodeSearchResultId(knowledgeVersionId, 'workflow', encodeOpaqueKey([title, path, startLine, raw.id ?? index])),
    type: 'workflow',
    title,
    snippet: truncateSnippet(typeof raw.description === 'string' ? raw.description : title),
    sourceRef: path ? { path, startLine: startLine || undefined } : { path: title },
    score: null,
  };
}

/**
 * True when an API/workflow title or path matches the query.
 * @param {object} item Mapped or raw row.
 * @param {string} query Search string.
 * @returns {boolean}
 */
export function matchesQueryText(item, query) {
  const needle = query.toLowerCase();
  const haystacks = [item.title, item.name, item.url, item.path, item.filePath, item.handlerFile, item.handler, item.description];
  return haystacks.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

// --- from search/search.service.js ---
/**
 * Project search orchestration: gate → docs FTS + CodeGraph read lease.
 */
/** Per-type CodeGraph cap before merge. */
export const SEARCH_GRAPH_MAX_RESULTS = 15;

/** Document FTS cap before merge. */
export const SEARCH_DOC_MAX_RESULTS = 15;

/** Graph-backed type tokens. */
export const SEARCH_GRAPH_TYPES = Object.freeze(['code', 'symbol', 'workflow', 'api']);

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
 * @returns {Promise<object[]>}
 */
export async function searchProjectDocuments(input) {
  const rows = await searchDocumentSections(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
    },
    { q: input.q, limit: input.limit ?? SEARCH_DOC_MAX_RESULTS },
  );
  return rows.map((row) => mapDocSearchItem(row, input.knowledgeVersionId)).filter(Boolean);
}

/**
 * Maps a gate action to the search wrapper state.
 * @param {'allow' | 'queue' | 'deny'} action Gate action.
 * @returns {'ready' | 'updating' | 'unavailable'}
 */
export function stateFromGate(action) {
  if (action === 'allow') {
    return 'ready';
  }
  if (action === 'queue') {
    return 'updating';
  }
  return 'unavailable';
}

/**
 * Builds an empty search envelope.
 * @param {'ready' | 'updating' | 'unavailable'} state Wrapper state.
 * @param {{
 *   knowledgeVersionId?: string | null,
 *   knowledgeHealth?: string | null,
 *   q?: string,
 * }} [base] Shared fields.
 * @returns {object}
 */
export function emptySearchEnvelope(state, base = {}) {
  return {
    state,
    knowledgeVersionId: base.knowledgeVersionId ?? null,
    knowledgeHealth: base.knowledgeHealth ?? null,
    q: base.q ?? '',
    items: [],
    cursor: null,
  };
}

/**
 * Pages merged items with a keyset cursor.
 * @param {object[]} items Sorted items.
 * @param {string | undefined} cursor Opaque cursor.
 * @param {number} limit Page size.
 * @returns {{ items: object[], cursor: string | null }}
 */
export function pageSearchItems(items, cursor, limit) {
  const decoded = cursor ? decodeSearchCursor(cursor) : null;
  if (cursor && !decoded) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'cursor', message: 'cursor is not a valid search keyset' }],
    });
  }
  const following = items.filter((item) => isAfterSearchCursor(item, decoded));
  const page = following.slice(0, limit);
  return {
    items: page,
    cursor: following.length > page.length ? encodeSearchCursor(page[page.length - 1]) : null,
  };
}

/**
 * Collects graph-backed hits for the requested types.
 * @param {object} adapter CodeGraph adapter.
 * @param {object} graph Open graph.
 * @param {string} q Query.
 * @param {string[]} types Requested types.
 * @param {string} knowledgeVersionId Current version.
 * @returns {object[]}
 */
export function collectGraphSearchItems(adapter, graph, q, types, knowledgeVersionId) {
  /** @type {object[]} */
  const items = [];
  const wantCode = types.includes('code');
  const wantSymbol = types.includes('symbol');
  if (wantCode || wantSymbol) {
    const hits = adapter.querySymbols(graph, q, SEARCH_GRAPH_MAX_RESULTS);
    for (const raw of hits) {
      const node = unwrapGraphNode(raw);
      const fileLike = isFileLikeNode(node);
      if (wantCode && fileLike) {
        const mapped = mapGraphSearchItem(raw, knowledgeVersionId, 'code');
        if (mapped) {
          items.push(mapped);
        }
        continue;
      }
      if (wantSymbol && !fileLike) {
        const mapped = mapGraphSearchItem(raw, knowledgeVersionId, 'symbol');
        if (mapped) {
          items.push(mapped);
        }
      }
    }
  }
  if (types.includes('api')) {
    const apiHits = adapter.queryApis(graph, SEARCH_GRAPH_MAX_RESULTS);
    apiHits.forEach((raw, index) => {
      if (!matchesQueryText(raw, q) && !matchesQueryText({ title: raw.url ?? raw.name }, q)) {
        return;
      }
      const mapped = mapApiSearchItem(raw, knowledgeVersionId, index);
      if (mapped) {
        items.push(mapped);
      }
    });
  }
  if (types.includes('workflow')) {
    const workflowHits = adapter.queryWorkflows(graph, SEARCH_GRAPH_MAX_RESULTS);
    workflowHits.forEach((raw, index) => {
      if (!matchesQueryText(raw, q)) {
        return;
      }
      const mapped = mapWorkflowSearchItem(raw, knowledgeVersionId, index);
      if (mapped) {
        items.push(mapped);
      }
    });
  }
  return items;
}

/**
 * Runs project-scoped keyword search over docs and the current graph.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   workspaceRoot: string,
 *   q: string,
 *   types: string[],
 *   cursor?: string,
 *   limit: number,
 * }} input Search request.
 * @returns {Promise<object>}
 */
export async function runProjectSearch(input) {
  const project = await loadActiveProject(input.orgId, input.projectId);
  const gate = await assertKnowledgeReadable({ orgId: input.orgId, projectId: input.projectId });
  const state = stateFromGate(gate.action);
  const knowledgeVersionId = gate.knowledgeVersionId
    ? String(gate.knowledgeVersionId)
    : project.currentKnowledgeVersionId
      ? String(project.currentKnowledgeVersionId)
      : null;
  if (state !== 'ready') {
    return emptySearchEnvelope(state, {
      knowledgeVersionId,
      knowledgeHealth: project.knowledgeHealth,
      q: input.q,
    });
  }

  return loadReadySearch({
    ...input,
    project,
    knowledgeVersionId: String(gate.knowledgeVersionId),
  });

  /**
   * Loads the active project or throws 404.
   * @param {string} orgId Tenant id.
   * @param {string} projectId Project id.
   * @returns {Promise<object>}
   */
  async function loadActiveProject(orgId, projectId) {
    const activeProject = await findProjectById(orgId, projectId);
    if (!activeProject || activeProject.status !== ROW_STATUS_ACTIVE) {
      throw ApiError.fromCode('PROJECT_NOT_FOUND');
    }
    return activeProject;
  }

  /**
   * Runs search after the gate allows (docs FTS + optional graph lease).
   * @param {object} readyInput Allowed-path inputs including project and knowledgeVersionId.
   * @returns {Promise<object>}
   */
  async function loadReadySearch(readyInput) {
    const knowledgeVersion = await findKnowledgeVersionById({
      orgId: readyInput.orgId,
      projectId: readyInput.projectId,
      knowledgeVersionId: readyInput.knowledgeVersionId,
    });
    const sourceVersionId = knowledgeVersion?.sourceVersionId ? String(knowledgeVersion.sourceVersionId) : null;

    /** @type {object[]} */
    let docItems = [];
    if (readyInput.types.includes('doc') && sourceVersionId) {
      docItems = await searchProjectDocuments({
        orgId: readyInput.orgId,
        projectId: readyInput.projectId,
        sourceVersionId,
        knowledgeVersionId: readyInput.knowledgeVersionId,
        q: readyInput.q,
      });
    }

    const wantsGraph = readyInput.types.some((type) => SEARCH_GRAPH_TYPES.includes(type));
    if (!wantsGraph) {
      const sorted = [...docItems].sort(compareSearchItems);
      const paged = pageSearchItems(sorted, readyInput.cursor, readyInput.limit);
      return {
        state: 'ready',
        knowledgeVersionId: readyInput.knowledgeVersionId,
        knowledgeHealth: readyInput.project.knowledgeHealth,
        q: readyInput.q,
        ...paged,
      };
    }

    const workspacePath = resolveProjectWorkspacePath(readyInput.workspaceRoot, readyInput.orgId, readyInput.projectId);
    const adapter = createCodegraphAdapter();
    const leased = await adapter.acquireReadLease({
      orgId: readyInput.orgId,
      projectId: readyInput.projectId,
      workspacePath,
    });

    if (!leased.ok && leased.reason === 'writer') {
      const sorted = [...docItems].sort(compareSearchItems);
      const paged = pageSearchItems(sorted, readyInput.cursor, readyInput.limit);
      return {
        state: 'updating',
        knowledgeVersionId: readyInput.knowledgeVersionId,
        knowledgeHealth: readyInput.project.knowledgeHealth,
        q: readyInput.q,
        ...paged,
      };
    }

    if (!leased.ok) {
      const sorted = [...docItems].sort(compareSearchItems);
      const paged = pageSearchItems(sorted, readyInput.cursor, readyInput.limit);
      return {
        state: 'ready',
        knowledgeVersionId: readyInput.knowledgeVersionId,
        knowledgeHealth: readyInput.project.knowledgeHealth,
        q: readyInput.q,
        ...paged,
      };
    }

    try {
      if (leased.lease.expired) {
        const sorted = [...docItems].sort(compareSearchItems);
        const paged = pageSearchItems(sorted, readyInput.cursor, readyInput.limit);
        return {
          state: 'unavailable',
          knowledgeVersionId: readyInput.knowledgeVersionId,
          knowledgeHealth: readyInput.project.knowledgeHealth,
          q: readyInput.q,
          ...paged,
        };
      }
      const graphItems = collectGraphSearchItems(adapter, leased.lease.graph, readyInput.q, readyInput.types, readyInput.knowledgeVersionId);
      if (leased.lease.expired) {
        const sorted = [...docItems].sort(compareSearchItems);
        const paged = pageSearchItems(sorted, readyInput.cursor, readyInput.limit);
        return {
          state: 'unavailable',
          knowledgeVersionId: readyInput.knowledgeVersionId,
          knowledgeHealth: readyInput.project.knowledgeHealth,
          q: readyInput.q,
          ...paged,
        };
      }
      const sorted = [...docItems, ...graphItems].sort(compareSearchItems);
      const paged = pageSearchItems(sorted, readyInput.cursor, readyInput.limit);
      return {
        state: 'ready',
        knowledgeVersionId: readyInput.knowledgeVersionId,
        knowledgeHealth: readyInput.project.knowledgeHealth,
        q: readyInput.q,
        ...paged,
      };
    } finally {
      leased.lease.release();
    }
  }
}

/**
 * Parses HTTP query and runs search.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   workspaceRoot: string,
 *   query: unknown,
 * }} input Route input.
 * @returns {Promise<object>}
 */
export async function runProjectSearchFromQuery(input) {
  const parsed = parseSearchQuery(input.query);
  return runProjectSearch({
    orgId: input.orgId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    q: parsed.q,
    types: parsed.types,
    cursor: parsed.cursor,
    limit: parsed.limit,
  });
}

// --- from search/search.routes.js ---
/**
 * GET /knowledge/search/run/:projectId — unified project search (docs, code graph, symbols).
 * @param {import('fastify').FastifyRequest} request Fastify request.
 * @returns {Promise<object>} Merged search results for the current knowledge version.
 */
export async function searchProjectHttp(request) {
  const result = await runProjectSearchFromQuery({
    orgId: request.projectScope.orgId,
    projectId: request.projectScope.projectId,
    workspaceRoot: request.server.config.workspace.root,
    query: request.query,
  });
  await recordProjectActivity({
    orgId: request.projectScope.orgId,
    projectId: request.projectScope.projectId,
    userId: request.projectScope.userId,
    kind: 'search.executed',
    quantity: 1,
    unit: 'calls',
    sourceRef: request.id,
    dedupeKey: `search.executed:${request.id}`,
    log: request.log,
  });
  return result;
}
