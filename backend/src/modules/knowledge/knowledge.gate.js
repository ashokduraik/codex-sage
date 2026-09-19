/**
 * Internal Q&A / browse gate — allow, queue, or deny without taking a CodeGraph read lease.
 */
import { getCatalogEntry } from '../../platform/errorCatalog.js';
import { findProjectById } from '../projects/index.js';
import { hasActiveProjectWriterLock } from '../../worker/projectJobLock.js';

/**
 * Builds a gate result from a catalog code.
 * @param {'allow' | 'queue' | 'deny'} action Gate action.
 * @param {string} code Error / status code.
 * @param {string} [knowledgeVersionId] Current knowledge version when allowing.
 * @returns {{
 *   action: 'allow' | 'queue' | 'deny',
 *   code?: string,
 *   message?: string,
 *   knowledgeVersionId?: string,
 * }}
 */
function gateResult(action, code, knowledgeVersionId) {
  if (action === 'allow') {
    return { action: 'allow', knowledgeVersionId };
  }
  const entry = getCatalogEntry(code);
  return {
    action,
    code,
    message: entry?.message ?? 'Project knowledge is not available.',
  };
}

/**
 * Decides whether project knowledge may be read for chat/search/browse.
 * @param {{ orgId: string, projectId: string }} scope Tenant + project.
 * @param {{
 *   findProject?: typeof findProjectById,
 *   hasWriterLock?: typeof hasActiveProjectWriterLock,
 * }} [deps] Test seams.
 * @returns {Promise<{
 *   action: 'allow' | 'queue' | 'deny',
 *   code?: string,
 *   message?: string,
 *   knowledgeVersionId?: string,
 * }>}
 */
export async function assertKnowledgeReadable(scope, deps = {}) {
  const findProject = deps.findProject ?? findProjectById;
  const hasWriterLock = deps.hasWriterLock ?? hasActiveProjectWriterLock;

  const project = await findProject(scope.orgId, scope.projectId);
  if (!project) {
    return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
  }

  if (project.lifecycleStatus === 'archived') {
    return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
  }

  if (project.knowledgeHealth === 'failed') {
    return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
  }

  const knowledgeVersionId = project.currentKnowledgeVersionId
    ? String(project.currentKnowledgeVersionId)
    : null;
  if (!knowledgeVersionId) {
    return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
  }

  if (project.knowledgeHealth === 'updating') {
    return gateResult('queue', 'KNOWLEDGE_UPDATING');
  }

  const writerActive = await hasWriterLock({
    orgId: scope.orgId,
    projectId: scope.projectId,
  });
  if (writerActive) {
    return gateResult('queue', 'KNOWLEDGE_UPDATING');
  }

  const healthOk =
    project.knowledgeHealth === 'ready' || project.knowledgeHealth === 'partially_available';
  const lifecycleOk =
    project.lifecycleStatus === 'knowledge_ready' ||
    project.lifecycleStatus === 'partially_available';
  if (healthOk && lifecycleOk) {
    return gateResult('allow', undefined, knowledgeVersionId);
  }

  return gateResult('deny', 'KNOWLEDGE_UNAVAILABLE');
}
