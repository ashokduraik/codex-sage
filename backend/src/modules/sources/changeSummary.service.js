/**
 * Maps persisted Phase 29 change summaries to the HTTP DTO.
 */
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { findKnowledgeVersionById } from '../knowledge/index.js';
import { findProjectById } from '../projects/index.js';
import { findLatestComputedChangeSummary } from './sourceChangeSummary.repository.js';

/**
 * Maps path strings to `{ path, impact: null }` objects.
 * @param {unknown} paths Stored path list.
 * @returns {Array<{ path: string, impact: null }>}
 */
export function mapSummaryPaths(paths) {
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths
    .filter((filePath) => typeof filePath === 'string' && filePath.length > 0)
    .map((filePath) => ({ path: filePath, impact: null }));
}

/**
 * Maps a stored summary row to the frontend change-summary shape.
 * @param {object} row Lean SourceChangeSummary.
 * @param {Date | string | null | undefined} publishedAt Knowledge publishedAt.
 * @returns {object}
 */
export function mapChangeSummaryDto(row, publishedAt) {
  const counts = row.counts ?? {};
  const paths = row.paths ?? {};
  return {
    sourceVersionId: row.sourceVersionId ? String(row.sourceVersionId) : null,
    knowledgeVersionId: row.knowledgeVersionId ? String(row.knowledgeVersionId) : null,
    publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
    counts: {
      added: Number(counts.added) || 0,
      modified: Number(counts.changed) || 0,
      removed: Number(counts.removed) || 0,
    },
    impact: {
      apisChanged: null,
      workflowsChanged: null,
      documentationConflicts: 0,
    },
    paths: {
      added: mapSummaryPaths(paths.added),
      modified: mapSummaryPaths(paths.changed),
      removed: mapSummaryPaths(paths.removed),
    },
    conflicts: [],
  };
}

/**
 * Loads the latest computed change summary for a project.
 * @param {{ orgId: string, projectId: string }} input Scope.
 * @param {{
 *   findProject?: typeof findProjectById,
 *   findLatest?: typeof findLatestComputedChangeSummary,
 *   findKnowledgeVersion?: typeof findKnowledgeVersionById,
 * }} [deps] Test seams.
 * @returns {Promise<object>}
 */
export async function loadLatestChangeSummary(input, deps = {}) {
  const findProject = deps.findProject ?? findProjectById;
  const findLatest = deps.findLatest ?? findLatestComputedChangeSummary;
  const findKnowledgeVersion = deps.findKnowledgeVersion ?? findKnowledgeVersionById;

  const project = await findProject(input.orgId, input.projectId);
  if (!project || project.status !== ROW_STATUS_ACTIVE) {
    throw ApiError.fromCode('PROJECT_NOT_FOUND');
  }

  const row = await findLatest({ orgId: input.orgId, projectId: input.projectId });
  if (!row) {
    throw ApiError.fromCode('CHANGE_SUMMARY_NOT_FOUND');
  }

  let publishedAt = null;
  if (row.knowledgeVersionId) {
    const version = await findKnowledgeVersion({
      orgId: input.orgId,
      projectId: input.projectId,
      knowledgeVersionId: String(row.knowledgeVersionId),
    });
    publishedAt = version?.publishedAt ?? null;
  }

  return mapChangeSummaryDto(row, publishedAt);
}
