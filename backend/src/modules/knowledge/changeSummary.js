/**
 * knowledge/changeSummary.js — merged resource file.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { SourceChangeSummary } from '../../models/sourceChangeSummary.model.js';
import { assertOrgId, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { findProjectById } from '../masters/index.js';
import { findKnowledgeVersionById } from './knowledge.js';
import mongoose from 'mongoose';

// --- from sources/sourceChangeSummary.repository.js ---
/**
 * Tenant-scoped persistence for source change summaries.
 */
/**
 * Finds the active change summary for an incoming source version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 * }} scope Scope.
 * @returns {Promise<object | null>}
 */
export async function findChangeSummaryForVersion(scope) {
  assertOrgId(scope.orgId);
  if (!mongoose.isValidObjectId(String(scope.sourceVersionId))) {
    return null;
  }
  return SourceChangeSummary.findOne({
    orgId: scope.orgId,
    projectId: scope.projectId,
    sourceVersionId: scope.sourceVersionId,
    status: ROW_STATUS_ACTIVE,
  })
    .lean()
    .exec();
}

/**
 * Finds the newest computed change summary for a project.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 * }} scope Tenant + project.
 * @returns {Promise<object | null>}
 */
export async function findLatestComputedChangeSummary(scope) {
  assertOrgId(scope.orgId);
  return SourceChangeSummary.findOne({
    orgId: scope.orgId,
    projectId: scope.projectId,
    status: ROW_STATUS_ACTIVE,
    diffStatus: 'computed',
  })
    .sort({ computedAt: -1, createdAt: -1, _id: -1 })
    .lean()
    .exec();
}

/**
 * Upserts a computed change summary for an incoming source version.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   projectId: string | import('mongoose').Types.ObjectId,
 *   sourceVersionId: string | import('mongoose').Types.ObjectId,
 *   previousSourceVersionId?: string | import('mongoose').Types.ObjectId | null,
 *   knowledgeVersionId?: string | import('mongoose').Types.ObjectId | null,
 *   added: string[],
 *   removed: string[],
 *   changed: string[],
 *   unchanged: string[],
 *   counts: { added: number, removed: number, changed: number, unchanged: number },
 * }} input Summary fields.
 * @returns {Promise<object>}
 */
export async function upsertChangeSummary(input) {
  assertOrgId(input.orgId);
  const now = new Date();
  const previousSourceVersionId = input.previousSourceVersionId ? new mongoose.Types.ObjectId(String(input.previousSourceVersionId)) : null;
  const knowledgeVersionId = input.knowledgeVersionId ? new mongoose.Types.ObjectId(String(input.knowledgeVersionId)) : null;
  const setFields = {
    previousSourceVersionId,
    knowledgeVersionId,
    counts: input.counts,
    paths: {
      added: input.added,
      removed: input.removed,
      changed: input.changed,
      unchanged: input.unchanged,
    },
    computedAt: now,
    diffStatus: 'computed',
    updatedAt: now,
  };
  const result = await SourceChangeSummary.findOneAndUpdate(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      sourceVersionId: input.sourceVersionId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: setFields,
      $setOnInsert: {
        orgId: input.orgId,
        projectId: input.projectId,
        sourceVersionId: input.sourceVersionId,
        status: ROW_STATUS_ACTIVE,
        createdAt: now,
        createdBy: null,
        updatedBy: null,
      },
    },
    { upsert: true, returnDocument: 'after', lean: true },
  ).exec();
  return result;
}

// --- from sources/changeSummary.service.js ---
/**
 * Maps persisted Phase 29 change summaries to the HTTP DTO.
 */
/**
 * Maps path strings to `{ path, impact: null }` objects.
 * @param {unknown} paths Stored path list.
 * @returns {Array<{ path: string, impact: null }>}
 */
export function mapSummaryPaths(paths) {
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths.filter((filePath) => typeof filePath === 'string' && filePath.length > 0).map((filePath) => ({ path: filePath, impact: null }));
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
 * @returns {Promise<object>}
 */
export async function loadLatestChangeSummary(input) {
  const project = await findProjectById(input.orgId, input.projectId);
  if (!project || project.status !== ROW_STATUS_ACTIVE) {
    throw ApiError.fromCode('PROJECT_NOT_FOUND');
  }

  const row = await findLatestComputedChangeSummary({ orgId: input.orgId, projectId: input.projectId });
  if (!row) {
    throw ApiError.fromCode('CHANGE_SUMMARY_NOT_FOUND');
  }

  let publishedAt = null;
  if (row.knowledgeVersionId) {
    const version = await findKnowledgeVersionById({
      orgId: input.orgId,
      projectId: input.projectId,
      knowledgeVersionId: String(row.knowledgeVersionId),
    });
    publishedAt = version?.publishedAt ?? null;
  }

  return mapChangeSummaryDto(row, publishedAt);
}

// --- from sources/changeSummary.routes.js ---
/**
 * Latest source change-summary HTTP route (knowledge updates URL).
 */
/**
 * Registers GET /projects/:projectId/knowledge/updates/latest under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function changeSummaryRoutes(app) {
  app.get(
    '/projects/:projectId/knowledge/updates/latest',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireProjectPermission(['knowledge.browse', 'knowledge.view'], {
        mode: 'any',
      }),
    },
    async (request) =>
      loadLatestChangeSummary({
        orgId: request.projectScope.orgId,
        projectId: request.projectScope.projectId,
      }),
  );
}
