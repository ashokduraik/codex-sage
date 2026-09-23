/**
 * Project search orchestration: gate → docs FTS + CodeGraph read lease.
 */
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { createCodegraphAdapter } from '../codegraph/index.js';
import { assertKnowledgeReadable, findKnowledgeVersionById } from '../knowledge/index.js';
import { findProjectById } from '../projects/index.js';
import { resolveProjectWorkspacePath } from '../workspace/index.js';
import { SEARCH_GRAPH_MAX_RESULTS, SEARCH_GRAPH_TYPES } from './search.constants.js';
import {
  compareSearchItems,
  decodeSearchCursor,
  encodeSearchCursor,
  isAfterSearchCursor,
} from './search.ids.js';
import {
  isFileLikeNode,
  mapApiSearchItem,
  mapGraphSearchItem,
  mapWorkflowSearchItem,
  matchesQueryText,
  unwrapGraphNode,
} from './search.mapper.js';
import { searchProjectDocuments } from './search.repository.js';
import { parseSearchQuery } from './search.schemas.js';

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
 * Loads the active project or throws 404.
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {typeof findProjectById} findProject Finder.
 * @returns {Promise<object>}
 */
async function loadActiveProject(orgId, projectId, findProject) {
  const project = await findProject(orgId, projectId);
  if (!project || project.status !== ROW_STATUS_ACTIVE) {
    throw ApiError.fromCode('PROJECT_NOT_FOUND');
  }
  return project;
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
 * Runs search after the gate allows.
 * @param {object} input Allowed-path inputs.
 * @param {object} deps Injected deps.
 * @returns {Promise<object>}
 */
async function loadReadySearch(input, deps) {
  const knowledgeVersion = await deps.findKnowledgeVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    knowledgeVersionId: input.knowledgeVersionId,
  });
  const sourceVersionId = knowledgeVersion?.sourceVersionId
    ? String(knowledgeVersion.sourceVersionId)
    : null;

  /** @type {object[]} */
  let docItems = [];
  if (input.types.includes('doc') && sourceVersionId) {
    docItems = await deps.searchDocuments({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId,
      knowledgeVersionId: input.knowledgeVersionId,
      q: input.q,
    });
  }

  const wantsGraph = input.types.some((type) => SEARCH_GRAPH_TYPES.includes(type));
  if (!wantsGraph) {
    const sorted = [...docItems].sort(compareSearchItems);
    const paged = pageSearchItems(sorted, input.cursor, input.limit);
    return {
      state: 'ready',
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      q: input.q,
      ...paged,
    };
  }

  const workspacePath = resolveProjectWorkspacePath(
    input.workspaceRoot,
    input.orgId,
    input.projectId,
  );
  const adapter = deps.createAdapter();
  const leased = await adapter.acquireReadLease({
    orgId: input.orgId,
    projectId: input.projectId,
    workspacePath,
  });

  if (!leased.ok && leased.reason === 'writer') {
    const sorted = [...docItems].sort(compareSearchItems);
    const paged = pageSearchItems(sorted, input.cursor, input.limit);
    return {
      state: 'updating',
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      q: input.q,
      ...paged,
    };
  }

  if (!leased.ok) {
    const sorted = [...docItems].sort(compareSearchItems);
    const paged = pageSearchItems(sorted, input.cursor, input.limit);
    return {
      state: 'ready',
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      q: input.q,
      ...paged,
    };
  }

  try {
    if (leased.lease.expired) {
      const sorted = [...docItems].sort(compareSearchItems);
      const paged = pageSearchItems(sorted, input.cursor, input.limit);
      return {
        state: 'unavailable',
        knowledgeVersionId: input.knowledgeVersionId,
        knowledgeHealth: input.project.knowledgeHealth,
        q: input.q,
        ...paged,
      };
    }
    const graphItems = collectGraphSearchItems(
      adapter,
      leased.lease.graph,
      input.q,
      input.types,
      input.knowledgeVersionId,
    );
    if (leased.lease.expired) {
      const sorted = [...docItems].sort(compareSearchItems);
      const paged = pageSearchItems(sorted, input.cursor, input.limit);
      return {
        state: 'unavailable',
        knowledgeVersionId: input.knowledgeVersionId,
        knowledgeHealth: input.project.knowledgeHealth,
        q: input.q,
        ...paged,
      };
    }
    const sorted = [...docItems, ...graphItems].sort(compareSearchItems);
    const paged = pageSearchItems(sorted, input.cursor, input.limit);
    return {
      state: 'ready',
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      q: input.q,
      ...paged,
    };
  } finally {
    leased.lease.release();
  }
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
 * @param {{
 *   findProject?: typeof findProjectById,
 *   assertReadable?: typeof assertKnowledgeReadable,
 *   findKnowledgeVersion?: typeof findKnowledgeVersionById,
 *   searchDocuments?: typeof searchProjectDocuments,
 *   createAdapter?: () => object,
 * }} [deps] Test seams.
 * @returns {Promise<object>}
 */
export async function runProjectSearch(input, deps = {}) {
  const findProject = deps.findProject ?? findProjectById;
  const assertReadable = deps.assertReadable ?? assertKnowledgeReadable;
  const findKnowledgeVersion = deps.findKnowledgeVersion ?? findKnowledgeVersionById;
  const searchDocuments = deps.searchDocuments ?? searchProjectDocuments;
  const createAdapter = deps.createAdapter ?? createCodegraphAdapter;

  const project = await loadActiveProject(input.orgId, input.projectId, findProject);
  const gate = await assertReadable({ orgId: input.orgId, projectId: input.projectId });
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

  return loadReadySearch(
    {
      ...input,
      project,
      knowledgeVersionId: String(gate.knowledgeVersionId),
    },
    { findKnowledgeVersion, searchDocuments, createAdapter },
  );
}

/**
 * Parses HTTP query and runs search.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   workspaceRoot: string,
 *   query: unknown,
 * }} input Route input.
 * @param {Parameters<typeof runProjectSearch>[1]} [deps] Test seams.
 * @returns {Promise<object>}
 */
export async function runProjectSearchFromQuery(input, deps = {}) {
  const parsed = parseSearchQuery(input.query);
  return runProjectSearch(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      workspaceRoot: input.workspaceRoot,
      q: parsed.q,
      types: parsed.types,
      cursor: parsed.cursor,
      limit: parsed.limit,
    },
    deps,
  );
}
