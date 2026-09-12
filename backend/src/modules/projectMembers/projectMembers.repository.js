/**
 * ProjectMember repository — org-scoped queries and accessible-project id set.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import {
  assertOrgId,
  decodeCursor,
  encodeCursor,
  includeDeleted,
  softDelete,
  ROW_STATUS_ACTIVE,
  ROW_STATUS_DELETED,
} from '../../platform/data/index.js';
import { ProjectMember } from './projectMembers.model.js';

/** Default page size for GET /projects/:projectId/members. */
export const PROJECT_MEMBERS_LIST_DEFAULT_LIMIT = 20;

/** Hard cap on members list `limit`. */
export const PROJECT_MEMBERS_LIST_MAX_LIMIT = 100;

/**
 * Clamps a requested page size into the allowed range.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampProjectMembersListLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return PROJECT_MEMBERS_LIST_DEFAULT_LIMIT;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return PROJECT_MEMBERS_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(parsed), PROJECT_MEMBERS_LIST_MAX_LIMIT);
}

/**
 * Builds a keyset filter for createdAt/_id descending pages.
 * @param {{ t: string, i: string }} cursor Decoded cursor.
 * @returns {object}
 */
function keysetAfterFilter(cursor) {
  const createdAt = new Date(cursor.t);
  if (Number.isNaN(createdAt.getTime())) {
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
    $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: id } }],
  };
}

/**
 * Finds an active project member by project and user.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findActiveProjectMember(orgId, projectId, userId, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(userId)) {
    return null;
  }
  const query = ProjectMember.findOne({ orgId, projectId, userId });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Finds a project member including soft-deleted rows (for reactivation).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findProjectMemberIncludingDeleted(
  orgId,
  projectId,
  userId,
  options = {},
) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(userId)) {
    return null;
  }
  const query = includeDeleted(
    ProjectMember.findOne({ orgId, projectId, userId }).sort({ updatedAt: -1 }),
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Lists active project ids the user is a member of (accessible-project filter).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<string[]>}
 */
export async function listAccessibleProjectIdsForUser(orgId, userId, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(userId)) {
    return [];
  }
  const query = ProjectMember.find({ orgId, userId })
    .select({ projectId: 1 })
    .lean();
  if (options.session) {
    query.session(options.session);
  }
  const rows = await query.exec();
  return rows.map((row) => String(row.projectId));
}

/**
 * Lists active members for a project with keyset pagination.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{ cursor?: string, limit?: number }} [filters] List filters.
 * @returns {Promise<{
 *   items: import('mongoose').Document[],
 *   nextCursor: string | null,
 * }>}
 */
export async function listProjectMembers(orgId, projectId, filters = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return { items: [], nextCursor: null };
  }
  const limit = clampProjectMembersListLimit(filters.limit);
  /** @type {Record<string, unknown>} */
  const query = { orgId, projectId, status: ROW_STATUS_ACTIVE };

  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    Object.assign(query, keysetAfterFilter(decoded));
  }

  const rows = await ProjectMember.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      t: last.createdAt.toISOString(),
      i: String(last._id),
    });
  }
  return { items, nextCursor };
}

/**
 * Inserts a new active project member.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   projectId: string,
 *   userId: import('mongoose').Types.ObjectId | string,
 *   roleId?: import('mongoose').Types.ObjectId | string | null,
 *   permissions?: string[],
 *   addedByUserId: import('mongoose').Types.ObjectId | string,
 *   createdBy?: import('mongoose').Types.ObjectId | string | null,
 * }} input Create fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createProjectMember(orgId, input, options = {}) {
  assertOrgId(orgId);
  const [doc] = await ProjectMember.create(
    [
      {
        orgId,
        projectId: input.projectId,
        userId: input.userId,
        roleId: input.roleId ?? null,
        permissions: input.permissions ?? [],
        addedByUserId: input.addedByUserId,
        createdBy: input.createdBy ?? input.addedByUserId,
        updatedBy: input.createdBy ?? input.addedByUserId,
      },
    ],
    options.session ? { session: options.session } : undefined,
  );
  return doc;
}

/**
 * Reactivates a soft-deleted member and refreshes overlay fields.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} memberId ProjectMember _id.
 * @param {{
 *   roleId?: import('mongoose').Types.ObjectId | string | null,
 *   permissions?: string[],
 *   addedByUserId: import('mongoose').Types.ObjectId | string,
 *   updatedBy?: import('mongoose').Types.ObjectId | string | null,
 * }} patch Overlay and actor.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function reactivateProjectMember(orgId, memberId, patch, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(memberId)) {
    return null;
  }
  const query = includeDeleted(
    ProjectMember.findOneAndUpdate(
      { _id: memberId, orgId, status: ROW_STATUS_DELETED },
      {
        $set: {
          status: ROW_STATUS_ACTIVE,
          roleId: patch.roleId ?? null,
          permissions: patch.permissions ?? [],
          addedByUserId: patch.addedByUserId,
          updatedBy: patch.updatedBy ?? patch.addedByUserId,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    ),
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Soft-deletes an active project member.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{
 *   updatedBy?: import('mongoose').Types.ObjectId | string | null,
 *   session?: import('mongoose').ClientSession,
 * }} [options] Actor and session.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteProjectMember(orgId, projectId, userId, options = {}) {
  assertOrgId(orgId);
  return softDelete(
    ProjectMember,
    { orgId, projectId, userId },
    { updatedBy: options.updatedBy ?? null, session: options.session },
  );
}
