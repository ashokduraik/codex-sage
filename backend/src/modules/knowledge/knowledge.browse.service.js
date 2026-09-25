/**
 * Knowledge browse orchestration: gate → read lease → bounded queries.
 */
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { createCodegraphAdapter } from '../codegraph/index.js';
import { listSectionsForVersion } from '../documents/index.js';
import { findProjectById } from '../projects/index.js';
import { resolveProjectWorkspacePath } from '../sources/index.js';
import { assertKnowledgeReadable } from './knowledge.gate.js';
import { findKnowledgeVersionById } from './knowledgeVersion.repository.js';

/** Default page size for list browse routes. */
export const KNOWLEDGE_BROWSE_PAGE_SIZE = 50;

/** Hard cap on browse `limit`. */
export const KNOWLEDGE_BROWSE_MAX_LIMIT = 100;

/** Minimum `q` length for symbol lookup. */
export const KNOWLEDGE_SYMBOL_QUERY_MIN_LEN = 2;

/** Cap on extractive summary text. */
export const KNOWLEDGE_SUMMARY_MAX_CHARS = 4000;

/**
 * Builds the shared browse envelope.
 * @param {'ready' | 'updating' | 'unavailable'} state Gate wrapper state.
 * @param {{
 *   knowledgeVersionId?: string | null,
 *   knowledgeHealth?: string | null,
 * }} [base] Shared fields.
 * @returns {object}
 */
export function emptyBrowseEnvelope(state, base = {}) {
  return {
    state,
    knowledgeVersionId: base.knowledgeVersionId ?? null,
    knowledgeHealth: base.knowledgeHealth ?? null,
    facets: [],
    items: [],
    cursor: null,
    summary: '',
    capabilities: [],
    title: '',
    dimensions: {},
    partialKnowledge: { excludedFromGraphCount: 0 },
  };
}

/**
 * Facets that have data. Empty categories are omitted (explorer §71).
 * @param {{
 *   hasSummary?: boolean,
 *   hasWorkflows?: boolean,
 *   hasApis?: boolean,
 *   hasSymbols?: boolean,
 *   hasDocumentation?: boolean,
 * }} flags Availability flags.
 * @returns {Array<{ key: string, available: true }>}
 */
export function mapBrowseFacets(flags) {
  /** @type {Array<{ key: string, available: true }>} */
  const facets = [];
  if (flags.hasSummary) {
    facets.push({ key: 'summary', available: true });
  }
  if (flags.hasWorkflows) {
    facets.push({ key: 'workflows', available: true });
  }
  if (flags.hasApis) {
    facets.push({ key: 'apis', available: true });
  }
  if (flags.hasSymbols) {
    facets.push({ key: 'symbols', available: true });
  }
  if (flags.hasDocumentation) {
    facets.push({ key: 'documentation', available: true });
  }
  return facets;
}

/**
 * Maps a CodeGraph symbol/search hit to a browse item.
 * @param {object} raw Library node or search result.
 * @returns {object | null}
 */
export function mapSymbolItem(raw) {
  const node = raw?.node && typeof raw.node === 'object' ? raw.node : raw;
  if (!node || typeof node !== 'object') {
    return null;
  }
  const name = typeof node.name === 'string' ? node.name : null;
  const path = typeof node.filePath === 'string' ? node.filePath : null;
  if (!name || !path) {
    return null;
  }
  const startLine = Number(node.startLine) || null;
  const endLine = Number(node.endLine) || startLine;
  return {
    id: typeof node.id === 'string' ? node.id : `${path}:${name}:${startLine ?? 0}`,
    name,
    kind: typeof node.kind === 'string' ? node.kind : 'symbol',
    path,
    line: startLine,
    sourceRef: { path, startLine, endLine },
  };
}

/**
 * Maps a routing-manifest entry or route node to an API item.
 * @param {object} raw Library row.
 * @param {number} index Fallback id salt.
 * @returns {object | null}
 */
export function mapApiItem(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.url === 'string') {
    return {
      id: `api:${raw.url}:${raw.handler ?? index}`,
      title: raw.url,
      description: typeof raw.handler === 'string' ? raw.handler : undefined,
      sourceRefs: raw.handlerFile
        ? [{ path: raw.handlerFile, startLine: Number(raw.handlerLine) || null, kind: 'code' }]
        : [],
    };
  }
  const path = typeof raw.filePath === 'string' ? raw.filePath : null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!path || !name) {
    return null;
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : `api:${path}:${name}`,
    title: name,
    sourceRefs: [{ path, startLine: Number(raw.startLine) || null, kind: 'code' }],
  };
}

/**
 * Caps extractive summary text.
 * @param {string} text Raw joined text.
 * @returns {string}
 */
export function capSummaryText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  if (text.length <= KNOWLEDGE_SUMMARY_MAX_CHARS) {
    return text;
  }
  return text.slice(0, KNOWLEDGE_SUMMARY_MAX_CHARS);
}

/**
 * Builds an extractive summary from docs + graph metadata (no LLM).
 * @param {{
 *   projectName?: string,
 *   stats?: { fileCount?: number, nodeCount?: number } | null,
 *   frameworks?: string[],
 *   sections?: Array<{ heading?: string | null, text?: string, path?: string }>,
 * }} input Source fragments.
 * @returns {string}
 */
export function buildExtractiveSummary(input) {
  const parts = [];
  if (input.projectName) {
    parts.push(input.projectName);
  }
  const fileCount = Number(input.stats?.fileCount);
  const nodeCount = Number(input.stats?.nodeCount);
  if (Number.isFinite(fileCount) && fileCount > 0) {
    parts.push(`${fileCount} indexed files`);
  }
  if (Number.isFinite(nodeCount) && nodeCount > 0) {
    parts.push(`${nodeCount} graph nodes`);
  }
  if (Array.isArray(input.frameworks) && input.frameworks.length > 0) {
    parts.push(`Detected: ${input.frameworks.join(', ')}`);
  }
  for (const section of input.sections ?? []) {
    const heading = typeof section.heading === 'string' ? section.heading.trim() : '';
    const text = typeof section.text === 'string' ? section.text.trim() : '';
    if (heading) {
      parts.push(heading);
    }
    if (text) {
      parts.push(text);
    }
  }
  return capSummaryText(parts.filter(Boolean).join('\n\n'));
}

/**
 * Honest health dimensions — no fabricated documentation score.
 * @param {{
 *   hasSource: boolean,
 *   publishedHealth?: string | null,
 *   excludedFromGraphCount: number,
 * }} input Facts.
 * @returns {object}
 */
export function mapHealthDimensions(input) {
  return {
    sourceCode: {
      state: input.hasSource ? 'present' : 'absent',
      detail: null,
    },
    publishedHealth: {
      state: input.publishedHealth || 'none',
      detail: null,
    },
    exclusions: {
      state: input.excludedFromGraphCount > 0 ? 'partial' : 'none',
      detail:
        input.excludedFromGraphCount > 0
          ? `${input.excludedFromGraphCount} files are not in the code map`
          : null,
    },
  };
}

/**
 * Clamps a browse page size.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampBrowseLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return KNOWLEDGE_BROWSE_PAGE_SIZE;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return KNOWLEDGE_BROWSE_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), KNOWLEDGE_BROWSE_MAX_LIMIT);
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
 * Maps a gate action to the browse wrapper state.
 * @param {'allow' | 'queue' | 'deny'} action Gate action.
 * @returns {'ready' | 'updating' | 'unavailable'}
 */
function stateFromGate(action) {
  if (action === 'allow') {
    return 'ready';
  }
  if (action === 'queue') {
    return 'updating';
  }
  return 'unavailable';
}

/**
 * Runs a browse kind after the gate allows.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   kind: 'index' | 'summary' | 'workflows' | 'apis' | 'symbols' | 'health',
 *   workspaceRoot: string,
 *   query?: { q?: string, cursor?: string, limit?: unknown },
 *   project: object,
 *   knowledgeVersionId: string,
 * }} input Allowed-path inputs.
 * @param {object} deps Injected deps.
 * @returns {Promise<object>}
 */
async function loadReadyBrowse(input, deps) {
  const knowledgeVersion = await deps.findKnowledgeVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    knowledgeVersionId: input.knowledgeVersionId,
  });
  const sourceVersionId = knowledgeVersion?.sourceVersionId
    ? String(knowledgeVersion.sourceVersionId)
    : null;
  const excludedFromGraphCount = Number(knowledgeVersion?.excludedFileCount ?? 0);
  const sections = sourceVersionId
    ? await deps.listSections({
        orgId: input.orgId,
        projectId: input.projectId,
        sourceVersionId,
      })
    : [];

  if (input.kind === 'health') {
    return {
      state: /** @type {'ready'} */ ('ready'),
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      lifecycleStatus: input.project.lifecycleStatus,
      dimensions: mapHealthDimensions({
        hasSource: Boolean(sourceVersionId),
        publishedHealth: knowledgeVersion?.publishedHealth ?? input.project.knowledgeHealth,
        excludedFromGraphCount,
      }),
      partialKnowledge: { excludedFromGraphCount },
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
    return {
      ...emptyBrowseEnvelope('updating', {
        knowledgeVersionId: input.knowledgeVersionId,
        knowledgeHealth: input.project.knowledgeHealth,
      }),
      lifecycleStatus: input.project.lifecycleStatus,
      partialKnowledge: { excludedFromGraphCount },
    };
  }

  if (!leased.ok) {
    const summary = buildExtractiveSummary({
      projectName: input.project.name,
      stats: null,
      frameworks: [],
      sections,
    });
    const base = {
      state: /** @type {'ready'} */ ('ready'),
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      partialKnowledge: { excludedFromGraphCount },
    };
    if (input.kind === 'summary') {
      return { ...base, title: input.project.name, summary, capabilities: [] };
    }
    if (input.kind === 'index') {
      return {
        ...base,
        facets: mapBrowseFacets({
          hasSummary: summary.length > 0,
          hasDocumentation: sections.length > 0,
        }),
        cursor: null,
      };
    }
    return { ...base, items: [], cursor: null };
  }

  try {
    if (leased.lease.expired) {
      return {
        ...emptyBrowseEnvelope('unavailable', {
          knowledgeVersionId: input.knowledgeVersionId,
          knowledgeHealth: input.project.knowledgeHealth,
        }),
        lifecycleStatus: input.project.lifecycleStatus,
        partialKnowledge: { excludedFromGraphCount },
      };
    }

    const graph = leased.lease.graph;
    const limit = clampBrowseLimit(input.query?.limit);
    const stats = adapter.queryStats(graph);
    const frameworks =
      typeof graph.getDetectedFrameworks === 'function' ? graph.getDetectedFrameworks() : [];
    const symbolKindCount = Number(stats?.nodesByKind?.function ?? 0) +
      Number(stats?.nodesByKind?.method ?? 0) +
      Number(stats?.nodeCount ?? 0);
    const apiHits =
      input.kind === 'index' || input.kind === 'apis' ? adapter.queryApis(graph, limit) : [];
    const workflowHits =
      input.kind === 'index' || input.kind === 'workflows'
        ? adapter.queryWorkflows(graph, limit)
        : [];
    const symbolHits =
      input.kind === 'symbols' ? adapter.querySymbols(graph, input.query?.q ?? '', limit) : [];
    const symbols = symbolHits.map(mapSymbolItem).filter(Boolean);
    const apis = apiHits.map((row, index) => mapApiItem(row, index)).filter(Boolean);
    const workflows = workflowHits.map((row, index) => mapApiItem(row, index)).filter(Boolean);
    const summary = buildExtractiveSummary({
      projectName: input.project.name,
      stats,
      frameworks: Array.isArray(frameworks) ? frameworks : [],
      sections,
    });

    if (leased.lease.expired) {
      return {
        ...emptyBrowseEnvelope('unavailable', {
          knowledgeVersionId: input.knowledgeVersionId,
          knowledgeHealth: input.project.knowledgeHealth,
        }),
        lifecycleStatus: input.project.lifecycleStatus,
        partialKnowledge: { excludedFromGraphCount },
      };
    }

    const base = {
      state: /** @type {'ready'} */ ('ready'),
      knowledgeVersionId: input.knowledgeVersionId,
      knowledgeHealth: input.project.knowledgeHealth,
      partialKnowledge: { excludedFromGraphCount },
    };

    if (input.kind === 'index') {
      return {
        ...base,
        facets: mapBrowseFacets({
          hasSummary: summary.length > 0,
          hasWorkflows: workflows.length > 0,
          hasApis: apis.length > 0,
          hasSymbols: symbolKindCount > 0,
          hasDocumentation: sections.length > 0,
        }),
        cursor: null,
      };
    }
    if (input.kind === 'summary') {
      return {
        ...base,
        title: input.project.name,
        summary,
        capabilities: [],
      };
    }
    if (input.kind === 'workflows') {
      return { ...base, items: workflows, cursor: null };
    }
    if (input.kind === 'apis') {
      return { ...base, items: apis, cursor: null };
    }
    if (input.kind === 'symbols') {
      return { ...base, items: symbols, cursor: null };
    }
    return {
      ...base,
      lifecycleStatus: input.project.lifecycleStatus,
      dimensions: mapHealthDimensions({
        hasSource: Boolean(sourceVersionId),
        publishedHealth: knowledgeVersion?.publishedHealth ?? input.project.knowledgeHealth,
        excludedFromGraphCount,
      }),
    };
  } finally {
    leased.lease.release();
  }
}

/**
 * Loads a browse payload for the current knowledge version.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   kind: 'index' | 'summary' | 'workflows' | 'apis' | 'symbols' | 'health',
 *   workspaceRoot: string,
 *   query?: { q?: string, cursor?: string, limit?: unknown },
 * }} input Browse request.
 * @param {{
 *   findProject?: typeof findProjectById,
 *   assertReadable?: typeof assertKnowledgeReadable,
 *   findKnowledgeVersion?: typeof findKnowledgeVersionById,
 *   listSections?: typeof listSectionsForVersion,
 *   createAdapter?: () => object,
 * }} [deps] Test seams.
 * @returns {Promise<object>}
 */
export async function loadKnowledgeBrowse(input, deps = {}) {
  const findProject = deps.findProject ?? findProjectById;
  const assertReadable = deps.assertReadable ?? assertKnowledgeReadable;
  const findKnowledgeVersion = deps.findKnowledgeVersion ?? findKnowledgeVersionById;
  const listSections = deps.listSections ?? listSectionsForVersion;
  const createAdapter = deps.createAdapter ?? createCodegraphAdapter;

  const project = await loadActiveProject(input.orgId, input.projectId, findProject);
  const gate = await assertReadable({ orgId: input.orgId, projectId: input.projectId });
  const state = stateFromGate(gate.action);
  if (state !== 'ready') {
    return {
      ...emptyBrowseEnvelope(state, {
        knowledgeVersionId: gate.knowledgeVersionId
          ? String(gate.knowledgeVersionId)
          : project.currentKnowledgeVersionId
            ? String(project.currentKnowledgeVersionId)
            : null,
        knowledgeHealth: project.knowledgeHealth,
      }),
      lifecycleStatus: project.lifecycleStatus,
    };
  }

  return loadReadyBrowse(
    {
      ...input,
      project,
      knowledgeVersionId: String(gate.knowledgeVersionId),
    },
    { findKnowledgeVersion, listSections, createAdapter },
  );
}
