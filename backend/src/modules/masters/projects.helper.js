/**
 * masters/projects.helper.js — merged resource file.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import { KNOWLEDGE_HEALTH_VALUES, LIFECYCLE_STATUS_VALUES, Project } from '../../models/projects.model.js';
import { assertOrgId, decodeCursor, encodeCursor, softDelete, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

// --- from projects/projects.lifecycle.js ---
/**
 * Project lifecycle state machine — pure validation only (no I/O).
 */
/** Allowed next states keyed by current lifecycle status. */
export const LIFECYCLE_TRANSITIONS = Object.freeze({
  creating: Object.freeze(['awaiting_source', 'connecting_repository', 'failed']),
  awaiting_source: Object.freeze(['source_received', 'connecting_repository', 'failed', 'archived']),
  connecting_repository: Object.freeze(['source_received', 'awaiting_source', 'failed', 'archived']),
  source_received: Object.freeze(['processing', 'connecting_repository', 'failed', 'archived']),
  processing: Object.freeze(['knowledge_ready', 'partially_available', 'failed', 'archived']),
  knowledge_ready: Object.freeze(['updating', 'failed', 'archived']),
  updating: Object.freeze(['knowledge_ready', 'partially_available', 'failed', 'archived']),
  partially_available: Object.freeze(['updating', 'knowledge_ready', 'failed', 'archived']),
  failed: Object.freeze(['awaiting_source', 'connecting_repository', 'processing', 'updating', 'archived']),
  archived: Object.freeze([]),
});

/** States that require worker source + knowledgeVersionId. */
export const WORKER_ONLY_LIFECYCLE_STATUSES = Object.freeze(['knowledge_ready', 'partially_available']);

/** Lifecycle states that cannot have knowledgeHealth ready. */
export const PRE_KNOWLEDGE_LIFECYCLE_STATUSES = Object.freeze(['creating', 'awaiting_source', 'connecting_repository', 'source_received']);

// --- from projects/projects.repository.js ---
/**
 * Project repository — org-scoped queries and conditional lifecycle updates.
 */
/** Default page size for GET /projects. */
export const PROJECTS_LIST_DEFAULT_LIMIT = 20;
/** Hard cap on `limit` query parameter. */
export const PROJECTS_LIST_MAX_LIMIT = 100;
/** Epoch used when encoding a null lastAccessedAt into a keyset cursor. */
const NULL_LAST_ACCESSED_CURSOR_ISO = '1970-01-01T00:00:00.000Z';

/**
 * Returns whether `status` is a known lifecycle code.
 * @param {string} status Candidate.
 * @returns {boolean}
 */
export function isKnownLifecycleStatus(status) {
  return LIFECYCLE_STATUS_VALUES.includes(status);
}

/**
 * Returns whether `health` is a known knowledgeHealth code.
 * @param {string} health Candidate.
 * @returns {boolean}
 */
export function isKnownKnowledgeHealth(health) {
  return KNOWLEDGE_HEALTH_VALUES.includes(health);
}

/**
 * Maps create sourceType to the first post-creating lifecycle status.
 * @param {'upload' | 'repository'} sourceType Create path.
 * @returns {'awaiting_source' | 'connecting_repository'}
 */
export function initialLifecycleAfterCreate(sourceType) {
  if (sourceType === 'repository') {
    return 'connecting_repository';
  }
  return 'awaiting_source';
}

/**
 * Throws when a lifecycle transition is not allowed.
 * @param {{
 *   from: string,
 *   to: string,
 *   source: 'api' | 'worker',
 *   knowledgeVersionId?: string | null,
 * }} input Transition request.
 * @throws {ApiError} INVALID_STATE_TRANSITION
 */
export function assertLifecycleTransitionAllowed(input) {
  const { from, to, source, knowledgeVersionId } = input;
  const allowed = LIFECYCLE_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: { from, to },
    });
  }

  if (WORKER_ONLY_LIFECYCLE_STATUSES.includes(to)) {
    if (source !== 'worker') {
      throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
        details: { from, to, reason: 'worker_source_required' },
      });
    }
    if (knowledgeVersionId === undefined || knowledgeVersionId === null || knowledgeVersionId === '') {
      throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
        details: { from, to, reason: 'knowledge_version_required' },
      });
    }
  }
}

/**
 * Throws when knowledgeHealth is incompatible with lifecycle.
 * @param {{ lifecycleStatus: string, knowledgeHealth: string }} input Pair to check.
 * @throws {ApiError} INVALID_STATE_TRANSITION
 */
export function assertKnowledgeHealthAllowed(input) {
  const { lifecycleStatus, knowledgeHealth } = input;
  const blockedBeforeProcessing = knowledgeHealth === 'ready' || knowledgeHealth === 'partially_available';
  if (blockedBeforeProcessing && PRE_KNOWLEDGE_LIFECYCLE_STATUSES.includes(lifecycleStatus)) {
    throw ApiError.fromCode('INVALID_STATE_TRANSITION', {
      details: {
        lifecycleStatus,
        knowledgeHealth,
        reason: 'knowledge_ready_before_processing',
      },
    });
  }
}

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
 * Normalizes list sort to a known field (default updatedAt).
 * @param {unknown} sort Raw sort.
 * @returns {'updatedAt' | 'lastAccessedAt'}
 */
export function resolveProjectsListSort(sort) {
  if (sort === 'lastAccessedAt') {
    return 'lastAccessedAt';
  }
  return 'updatedAt';
}

/**
 * Inserts a project row.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   name: string,
 *   description?: string,
 *   sourceType: 'upload' | 'repository',
 *   createdBy: import('mongoose').Types.ObjectId | string | null,
 *   members?: object[],
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
        lastAccessedAt: null,
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
        members: Array.isArray(input.members) ? input.members : [],
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
 *   sort?: 'updatedAt' | 'lastAccessedAt',
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
  const sortField = resolveProjectsListSort(filters.sort);
  /** @type {Record<string, unknown>} */
  const query = { orgId, status: ROW_STATUS_ACTIVE };

  if (Array.isArray(filters.projectIds)) {
    if (filters.projectIds.length === 0) {
      return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
    }
    query._id = {
      $in: filters.projectIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(String(id))),
    };
  }

  if (!filters.includeArchived) {
    query.lifecycleStatus = { $ne: 'archived' };
  }

  if (filters.q && String(filters.q).trim().length > 0) {
    const escaped = String(filters.q)
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.name = { $regex: escaped, $options: 'i' };
  }

  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    Object.assign(query, keysetAfterFilter(decoded, sortField));
  }

  /** @type {Record<string, 1 | -1>} */
  const sort = { [sortField]: -1, _id: -1 };
  const rows = await Project.find(query)
    .sort(sort)
    .limit(limit + 1)
    .exec();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      t: cursorTimestampForRow(last, sortField),
      i: String(last._id),
    });
  }
  return { items, pageInfo: { nextCursor, hasMore } };

  /**
   * Encodes the sort timestamp for the next cursor.
   * @param {import('mongoose').Document} row Project row.
   * @param {'updatedAt' | 'lastAccessedAt'} sortField Sort field.
   * @returns {string}
   */
  function cursorTimestampForRow(row, sortField) {
    if (sortField === 'lastAccessedAt') {
      if (row.lastAccessedAt instanceof Date) {
        return row.lastAccessedAt.toISOString();
      }
      return NULL_LAST_ACCESSED_CURSOR_ISO;
    }
    return row.updatedAt.toISOString();
  }
}

/**
 * Builds a keyset filter for a timestamp/_id descending page.
 * @param {{ t: string, i: string }} cursor Decoded cursor.
 * @param {'updatedAt' | 'lastAccessedAt'} sortField Sort field.
 * @returns {object}
 */
function keysetAfterFilter(cursor, sortField) {
  const stamp = new Date(cursor.t);
  if (Number.isNaN(stamp.getTime())) {
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
  if (sortField === 'lastAccessedAt') {
    // Null lastAccessedAt sorts last under descending order.
    if (cursor.t === NULL_LAST_ACCESSED_CURSOR_ISO) {
      return {
        $and: [{ lastAccessedAt: null }, { _id: { $lt: id } }],
      };
    }
    return {
      $or: [{ lastAccessedAt: { $lt: stamp, $ne: null } }, { lastAccessedAt: stamp, _id: { $lt: id } }, { lastAccessedAt: null }],
    };
  }
  return {
    $or: [{ updatedAt: { $lt: stamp } }, { updatedAt: stamp, _id: { $lt: id } }],
  };
}

/**
 * Sets lastAccessedAt to now without changing updatedAt semantics beyond mongoose defaults.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function touchProjectLastAccessedAt(orgId, projectId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return null;
  }
  const now = new Date();
  return Project.findOneAndUpdate(
    { _id: projectId, orgId, status: ROW_STATUS_ACTIVE },
    { $set: { lastAccessedAt: now } },
    { returnDocument: 'after' },
  ).exec();
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
  return Project.findOneAndUpdate({ _id: projectId, orgId, status: ROW_STATUS_ACTIVE }, { $set }, { returnDocument: 'after' }).exec();
}

/**
 * Updates the project's repository connection pointer.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{
 *   repositoryConnectionId: string | null,
 *   sourceType?: 'upload' | 'repository',
 *   updatedBy?: string | null,
 * }} input Pointer fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function updateProjectSourceConfig(orgId, projectId, input, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return null;
  }
  const query = Project.findOneAndUpdate(
    { _id: projectId, orgId, status: ROW_STATUS_ACTIVE },
    {
      $set: {
        'sourceConfig.sourceType': input.sourceType ?? 'repository',
        'sourceConfig.repositoryConnectionId': input.repositoryConnectionId,
        updatedBy: input.updatedBy ?? null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
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
 *   knowledgeHealth?: string | null,
 * }} transition Transition fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').Document | null>} Updated doc, or null when no match.
 */
export async function conditionalLifecycleUpdate(orgId, projectId, transition, options = {}) {
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
  if (transition.knowledgeHealth !== undefined && transition.knowledgeHealth !== null) {
    $set.knowledgeHealth = transition.knowledgeHealth;
  }

  const query = Project.findOneAndUpdate(
    {
      _id: projectId,
      orgId,
      status: ROW_STATUS_ACTIVE,
      lifecycleStatus: transition.from,
    },
    { $set },
    { returnDocument: 'after' },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Increments or decrements `counts.conversations`, floored at 0.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {number} delta Integer change (typically +1 or -1).
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function adjustProjectConversationCount(orgId, projectId, delta, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId) || !Number.isInteger(delta) || delta === 0) {
    return null;
  }
  const query = Project.findOneAndUpdate(
    {
      _id: projectId,
      orgId,
      status: ROW_STATUS_ACTIVE,
    },
    [
      {
        $set: {
          'counts.conversations': {
            $max: [0, { $add: [{ $ifNull: ['$counts.conversations', 0] }, delta] }],
          },
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Replaces cached source snapshot totals on the project (Health / overview).
 * Called after knowledge publish so list/detail show accepted and excluded file counts.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{
 *   files: number,
 *   excludedFiles: number,
 *   sourceVersions: number,
 * }} counts Absolute totals to store (floored at 0).
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional Mongo session.
 * @returns {Promise<import('mongoose').Document | null>} Updated project, or null when missing.
 */
export async function setProjectSourceSnapshotCounts(orgId, projectId, counts, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId) || !counts || typeof counts !== 'object') {
    return null;
  }
  const files = Math.max(0, Math.floor(Number(counts.files) || 0));
  const excludedFiles = Math.max(0, Math.floor(Number(counts.excludedFiles) || 0));
  const sourceVersions = Math.max(0, Math.floor(Number(counts.sourceVersions) || 0));
  const query = Project.findOneAndUpdate(
    {
      _id: projectId,
      orgId,
      status: ROW_STATUS_ACTIVE,
    },
    {
      $set: {
        'counts.files': files,
        'counts.excludedFiles': excludedFiles,
        'counts.sourceVersions': sourceVersions,
      },
    },
    { returnDocument: 'after' },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
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
  return softDelete(Project, { _id: projectId, orgId }, { updatedBy: options.updatedBy ?? null });
}
