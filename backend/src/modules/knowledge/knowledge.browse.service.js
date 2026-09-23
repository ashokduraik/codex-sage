/**
 * Knowledge browse orchestration: gate → read lease → bounded queries.
 */
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { createCodegraphAdapter } from '../codegraph/index.js';
import { listSectionsForVersion } from '../documents/index.js';
import { findProjectById } from '../projects/index.js';
import { resolveProjectWorkspacePath } from '../workspace/index.js';
import { assertKnowledgeReadable } from './knowledge.gate.js';
import { findKnowledgeVersionById } from './knowledgeVersion.repository.js';
import {
  KNOWLEDGE_BROWSE_MAX_LIMIT,
  KNOWLEDGE_BROWSE_PAGE_SIZE,
} from './knowledge.constants.js';
import {
  buildExtractiveSummary,
  emptyBrowseEnvelope,
  mapApiItem,
  mapBrowseFacets,
  mapHealthDimensions,
  mapSymbolItem,
} from './knowledge.browse.mapper.js';

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
