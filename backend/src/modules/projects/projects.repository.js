/**
 * Project repository — org-scoped queries and conditional lifecycle updates.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import {
  assertOrgId,
  decodeCursor,
  encodeCursor,
  softDelete,
  ROW_STATUS_ACTIVE,
} from '../../platform/data/index.js';
import { Project } from './projects.model.js';

/** Default page size for GET /projects. */
export const PROJECTS_LIST_DEFAULT_LIMIT = 20;

/** Hard cap on `limit` query parameter. */
export const PROJECTS_LIST_MAX_LIMIT = 100;

/**
 * Clamps a requested page size into the allowed range.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampProjectsListLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return PROJECTS_LIST_DEFAULT_LIMIT;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return PROJECTS_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(parsed), PROJECTS_LIST_MAX_LIMIT);
}

/**
 * Builds a keyset filter for updatedAt/_id descending pages.
 * @param {{ t: string, i: string }} cursor Decoded cursor.
 * @returns {object}
 */
function keysetAfterFilter(cursor) {
  const updatedAt = new Date(cursor.t);
  if (Number.isNaN(updatedAt.getTime())) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'cursor', message: 'cursor timestamp is invalid' }],
    });
  }
  if (!mongoose.isValidObjectId(cursor.i)) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'cursor', message: 'cursor id is invalid' }],
    });
  }
  const id = new mongoose.Types.ObjectId(cursor.i);
  return {
    $or: [{ updatedAt: { $lt: updatedAt } }, { updatedAt, _id: { $lt: id } }],
  };
}

/**
 * Inserts a project row.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   name: string,
 *   description?: string,
 *   sourceType: 'upload' | 'repository',
 *   createdBy: import('mongoose').Types.ObjectId | string | null,
 * }} input Create fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createProject(orgId, input, options = {}) {
  assertOrgId(orgId);
  const now = new Date();
  const [created] = await Project.create(
    [
      {
        orgId,
        name: input.name,
        description: input.description ?? '',
        lifecycleStatus: 'creating',
        lifecycleStatusChangedAt: now,
        knowledgeHealth: 'none',
        sourceConfig: { sourceType: input.sourceType },
        counts: {
          sourceVersions: 0,
          files: 0,
          excludedFiles: 0,
          conversations: 0,
        },
        settings: {},
        createdBy: input.createdBy ?? null,
        updatedBy: input.createdBy ?? null,
      },
    ],
    options.session ? { session: options.session } : undefined,
  );
  return created;
}

/**
 * Finds an active project by org and id.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findProjectById(orgId, projectId, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return null;
  }
  const query = Project.findOne({ _id: projectId, orgId });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Lists active projects with optional name search, archived filter, and ACL id filter.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   q?: string,
 *   includeArchived?: boolean,
 *   cursor?: string,
 *   limit?: number,
 *   projectIds?: string[] | null,
 *   emptyResult?: boolean,
 * }} [filters] List filters. `projectIds` restricts to those ids; `emptyResult` short-circuits.
 * @returns {Promise<{
 *   items: import('mongoose').Document[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }>}
 */
export async function listProjects(orgId, filters = {}) {
  assertOrgId(orgId);
  if (filters.emptyResult) {
    return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
  }
  const limit = clampProjectsListLimit(filters.limit);
  /** @type {Record<string, unknown>} */
  const query = { orgId, status: ROW_STATUS_ACTIVE };

  if (Array.isArray(filters.projectIds)) {
    if (filters.projectIds.length === 0) {
      return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
    }
    query._id = {
      $in: filters.projectIds
        .filter((id) => mongoose.isValidObjectId(id))
        .map((id) => new mongoose.Types.ObjectId(String(id))),
    };
  }

  if (!filters.includeArchived) {
    query.lifecycleStatus = { $ne: 'archived' };
  }

  if (filters.q && String(filters.q).trim().length > 0) {
    const escaped = String(filters.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.name = { $regex: escaped, $options: 'i' };
  }

  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    Object.assign(query, keysetAfterFilter(decoded));
  }

  const rows = await Project.find(query)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      t: last.updatedAt.toISOString(),
      i: String(last._id),
    });
  }
  return { items, pageInfo: { nextCursor, hasMore } };
}

/**
 * Patches name and/or description.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ name?: string, description?: string, updatedBy?: string | null }} patch Fields.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function updateProjectMetadata(orgId, projectId, patch) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return null;
  }
  /** @type {Record<string, unknown>} */
  const $set = { updatedBy: patch.updatedBy ?? null, updatedAt: new Date() };
  if (patch.name !== undefined) {
    $set.name = patch.name;
  }
  if (patch.description !== undefined) {
    $set.description = patch.description;
  }
  return Project.findOneAndUpdate(
    { _id: projectId, orgId, status: ROW_STATUS_ACTIVE },
    { $set },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Replaces the settings object on a project.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ settings: Record<string, unknown>, updatedBy?: string | null }} input Settings.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function updateProjectSettings(orgId, projectId, input) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return null;
  }
  return Project.findOneAndUpdate(
    { _id: projectId, orgId, status: ROW_STATUS_ACTIVE },
    {
      $set: {
        settings: input.settings,
        updatedBy: input.updatedBy ?? null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Conditionally updates lifecycleStatus when the current value still matches `from`.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{
 *   from: string,
 *   to: string,
 *   reasonCode?: string | null,
 *   updatedBy?: string | null,
 *   preArchiveLifecycleStatus?: string | null,
 *   clearPreArchive?: boolean,
 *   archivedAt?: Date | null,
 *   currentKnowledgeVersionId?: string | null,
 * }} transition Transition fields.
 * @returns {Promise<import('mongoose').Document | null>} Updated doc, or null when no match.
 */
export async function conditionalLifecycleUpdate(orgId, projectId, transition) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return null;
  }
  const now = new Date();
  /** @type {Record<string, unknown>} */
  const $set = {
    lifecycleStatus: transition.to,
    lifecycleStatusChangedAt: now,
    lifecycleStatusReasonCode: transition.reasonCode ?? null,
    updatedBy: transition.updatedBy ?? null,
    updatedAt: now,
  };
  if (transition.preArchiveLifecycleStatus !== undefined) {
    $set.preArchiveLifecycleStatus = transition.preArchiveLifecycleStatus;
  }
  if (transition.clearPreArchive) {
    $set.preArchiveLifecycleStatus = null;
  }
  if (transition.archivedAt !== undefined) {
    $set.archivedAt = transition.archivedAt;
  }
  if (transition.currentKnowledgeVersionId !== undefined) {
    $set.currentKnowledgeVersionId = transition.currentKnowledgeVersionId
      ? new mongoose.Types.ObjectId(String(transition.currentKnowledgeVersionId))
      : null;
  }

  return Project.findOneAndUpdate(
    {
      _id: projectId,
      orgId,
      status: ROW_STATUS_ACTIVE,
      lifecycleStatus: transition.from,
    },
    { $set },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Soft-deletes an active project.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ updatedBy?: string | null }} [options] Actor stamp.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteProject(orgId, projectId, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  }
  return softDelete(
    Project,
    { _id: projectId, orgId },
    { updatedBy: options.updatedBy ?? null },
  );
}
