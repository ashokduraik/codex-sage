/**
 * Re-resolves a stored search result id under the current knowledge version.
 */
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { createCodegraphAdapter } from '../codegraph/index.js';
import { findDocumentSectionById } from '../documents/index.js';
import { assertKnowledgeReadable, findKnowledgeVersionById } from '../knowledge/index.js';
import { findProjectById } from '../projects/index.js';
import { resolveProjectWorkspacePath } from '../workspace/index.js';
import { SEARCH_GRAPH_MAX_RESULTS, SEARCH_TYPES } from './search.constants.js';
import { decodeOpaqueKey, parseSearchResultId } from './search.ids.js';
import {
  mapApiSearchItem,
  mapDocSearchItem,
  mapGraphSearchItem,
  mapWorkflowSearchItem,
  toResolverEvidence,
} from './search.mapper.js';
import { collectGraphSearchItems } from './search.service.js';

/**
 * @typedef {{
 *   ok: true,
 *   evidence: { type: string, title: string, sourceRef: object, excerpt: string }
 * } | {
 *   ok: false,
 *   code: 'KNOWLEDGE_UNAVAILABLE' | 'SEARCH_RESULT_NOT_FOUND'
 * }} SearchResolveResult
 */

/**
 * Finds a mapped graph item whose id matches the stored result.
 * @param {object[]} items Mapped items.
 * @param {string} resultId Stored id.
 * @returns {object | null}
 */
function findItemById(items, resultId) {
  return items.find((item) => item.id === resultId) ?? null;
}

/**
 * Re-fetches a search hit for chat attachment resolution (phase 50).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   resultId: string,
 *   expectedKnowledgeVersionId?: string,
 *   workspaceRoot: string,
 * }} input Resolver input.
 * @param {{
 *   findProject?: typeof findProjectById,
 *   assertReadable?: typeof assertKnowledgeReadable,
 *   findKnowledgeVersion?: typeof findKnowledgeVersionById,
 *   findSection?: typeof findDocumentSectionById,
 *   createAdapter?: () => object,
 * }} [deps] Test seams.
 * @returns {Promise<SearchResolveResult>}
 */
export async function resolveSearchResultForChat(input, deps = {}) {
  const findProject = deps.findProject ?? findProjectById;
  const assertReadable = deps.assertReadable ?? assertKnowledgeReadable;
  const findKnowledgeVersion = deps.findKnowledgeVersion ?? findKnowledgeVersionById;
  const findSection = deps.findSection ?? findDocumentSectionById;
  const createAdapter = deps.createAdapter ?? createCodegraphAdapter;

  const parsed = parseSearchResultId(input.resultId);
  if (!parsed || !SEARCH_TYPES.includes(parsed.type)) {
    return { ok: false, code: 'SEARCH_RESULT_NOT_FOUND' };
  }
  if (
    input.expectedKnowledgeVersionId &&
    input.expectedKnowledgeVersionId !== parsed.knowledgeVersionId
  ) {
    return { ok: false, code: 'SEARCH_RESULT_NOT_FOUND' };
  }

  const project = await findProject(input.orgId, input.projectId);
  if (!project || project.status !== ROW_STATUS_ACTIVE) {
    return { ok: false, code: 'SEARCH_RESULT_NOT_FOUND' };
  }

  const gate = await assertReadable({ orgId: input.orgId, projectId: input.projectId });
  if (gate.action !== 'allow' || !gate.knowledgeVersionId) {
    return { ok: false, code: 'KNOWLEDGE_UNAVAILABLE' };
  }
  const currentVersionId = String(gate.knowledgeVersionId);
  if (currentVersionId !== parsed.knowledgeVersionId) {
    return { ok: false, code: 'SEARCH_RESULT_NOT_FOUND' };
  }

  const knowledgeVersion = await findKnowledgeVersion({
    orgId: input.orgId,
    projectId: input.projectId,
    knowledgeVersionId: currentVersionId,
  });
  const sourceVersionId = knowledgeVersion?.sourceVersionId
    ? String(knowledgeVersion.sourceVersionId)
    : null;

  if (parsed.type === 'doc') {
    if (!sourceVersionId) {
      return { ok: false, code: 'SEARCH_RESULT_NOT_FOUND' };
    }
    const section = await findSection({
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId,
      sectionId: parsed.opaqueKey,
    });
    const item = mapDocSearchItem(section, currentVersionId);
    if (!item || item.id !== input.resultId) {
      return { ok: false, code: 'SEARCH_RESULT_NOT_FOUND' };
    }
    return { ok: true, evidence: toResolverEvidence(item) };
  }

  const workspacePath = resolveProjectWorkspacePath(
    input.workspaceRoot,
    input.orgId,
    input.projectId,
  );
  const adapter = createAdapter();
  const leased = await adapter.acquireReadLease({
    orgId: input.orgId,
    projectId: input.projectId,
    workspacePath,
  });
  if (!leased.ok) {
    return { ok: false, code: 'KNOWLEDGE_UNAVAILABLE' };
  }

  try {
    if (leased.lease.expired) {
      return { ok: false, code: 'KNOWLEDGE_UNAVAILABLE' };
    }
    const [pathPart, namePart] = decodeOpaqueKey(parsed.opaqueKey);
    const queryHint = namePart || pathPart || parsed.opaqueKey;
    let items = collectGraphSearchItems(
      adapter,
      leased.lease.graph,
      queryHint,
      [parsed.type],
      currentVersionId,
    );
    let match = findItemById(items, input.resultId);
    if (!match && parsed.type === 'api') {
      const apiHits = adapter.queryApis(leased.lease.graph, SEARCH_GRAPH_MAX_RESULTS);
      items = apiHits
        .map((raw, index) => mapApiSearchItem(raw, currentVersionId, index))
        .filter(Boolean);
      match = findItemById(items, input.resultId);
    }
    if (!match && parsed.type === 'workflow') {
      const workflowHits = adapter.queryWorkflows(leased.lease.graph, SEARCH_GRAPH_MAX_RESULTS);
      items = workflowHits
        .map((raw, index) => mapWorkflowSearchItem(raw, currentVersionId, index))
        .filter(Boolean);
      match = findItemById(items, input.resultId);
    }
    if (!match && (parsed.type === 'symbol' || parsed.type === 'code')) {
      const symbolHits = adapter.querySymbols(leased.lease.graph, queryHint, SEARCH_GRAPH_MAX_RESULTS);
      items = symbolHits
        .map((raw) => mapGraphSearchItem(raw, currentVersionId, parsed.type))
        .filter(Boolean);
      match = findItemById(items, input.resultId);
    }
    if (!match) {
      return { ok: false, code: 'SEARCH_RESULT_NOT_FOUND' };
    }
    return { ok: true, evidence: toResolverEvidence(match) };
  } finally {
    leased.lease.release();
  }
}
