/**
 * masters/projectMembers.js — merged resource file.
 */
import { requireProjectPermission } from '../../http/preHandlers/requireProjectPermission.js';
import { Project } from '../../models/projects.model.js';
import {
  assertOrgId,
  ROW_STATUS_ACTIVE,
  ROW_STATUS_DELETED,
} from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import {
  resolveEffectivePermissions,
  isKnownPermissionKey,
  recordAuditEvent,
  buildAuditContextFromRequest,
} from '../access/index.js';
import { bumpOrganizationAclVersion, findOrganizationById } from './organizations.js';
import { findProjectById } from './projects.helper.js';
import { findRoleById } from './roles.js';
import { findUserById } from './users.js';
import mongoose from 'mongoose';
import { z } from 'zod';

// --- from projectMembers/projectAclCache.js ---
/**
 * Process-local TTL cache for resolved project ACL entries.
 * Entries are tagged with organization.aclVersion; stale versions are discarded on read.
 */
/** Worst-case staleness when aclVersion is unchanged (milliseconds). */
export const PROJECT_ACL_CACHE_TTL_MS = 5000;

/** Upper bound on cached ACL entries. */
export const PROJECT_ACL_CACHE_MAX_ENTRIES = 5000;

/**
 * @typedef {object} ProjectAclCacheValue
 * @property {'NO_ACCESS' | 'OK'} kind
 * @property {string[]} [permissions]
 * @property {number} aclVersion
 */

/**
 * @typedef {object} ProjectAclCacheEntry
 * @property {ProjectAclCacheValue} value
 * @property {number} expiresAtMs
 */

/**
 * Creates a project-ACL cache.
 * @param {{
 *   ttlMs?: number,
 *   maxEntries?: number,
 *   now?: () => number,
 *   enabled?: boolean,
 * }} [options] Optional overrides for tests.
 * @returns {{
 *   get: (orgId: string, userId: string, projectId: string, aclVersion: number) =>
 *     ProjectAclCacheValue | undefined,
 *   set: (
 *     orgId: string,
 *     userId: string,
 *     projectId: string,
 *     value: ProjectAclCacheValue,
 *   ) => void,
 *   invalidateOrganization: (orgId: string) => void,
 *   setEnabled: (enabled: boolean) => void,
 *   size: () => number,
 *   clear: () => void,
 *   isEnabled: () => boolean,
 * }}
 */
export function createProjectAclCache(options = {}) {
  const ttlMs = options.ttlMs ?? PROJECT_ACL_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? PROJECT_ACL_CACHE_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now());
  let enabled = options.enabled !== false;
  /** @type {Map<string, ProjectAclCacheEntry>} */
  const store = new Map();

  /**
   * @param {string} orgId
   * @param {string} userId
   * @param {string} projectId
   * @returns {string}
   */
  function cacheKey(orgId, userId, projectId) {
    return `${orgId}:${userId}:${projectId}`;
  }

  function evictIfNeeded() {
    const currentMs = now();
    for (const [key, entry] of store) {
      if (entry.expiresAtMs <= currentMs) {
        store.delete(key);
      }
    }
    while (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      store.delete(oldestKey);
    }
  }

  return {
    /**
     * Returns a cached value when present, unexpired, and matching aclVersion.
     * @param {string} orgId
     * @param {string} userId
     * @param {string} projectId
     * @param {number} aclVersion
     * @returns {ProjectAclCacheValue | undefined}
     */
    get(orgId, userId, projectId, aclVersion) {
      if (!enabled) {
        return undefined;
      }
      const key = cacheKey(orgId, userId, projectId);
      const entry = store.get(key);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAtMs <= now() || entry.value.aclVersion !== aclVersion) {
        store.delete(key);
        return undefined;
      }
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },

    /**
     * Stores a resolved ACL value.
     * @param {string} orgId
     * @param {string} userId
     * @param {string} projectId
     * @param {ProjectAclCacheValue} value
     */
    set(orgId, userId, projectId, value) {
      if (!enabled) {
        return;
      }
      evictIfNeeded();
      const key = cacheKey(orgId, userId, projectId);
      if (store.has(key)) {
        store.delete(key);
      } else if (store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey !== undefined) {
          store.delete(oldestKey);
        }
      }
      store.set(key, {
        value: {
          kind: value.kind,
          permissions: value.permissions ? Object.freeze([...value.permissions]) : undefined,
          aclVersion: value.aclVersion,
        },
        expiresAtMs: now() + ttlMs,
      });
    },

    /**
     * Drops every cached entry for an organization.
     * @param {string} orgId
     */
    invalidateOrganization(orgId) {
      const prefix = `${orgId}:`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    },

    /**
     * Enables or disables the cache (tests disable; production enables).
     * @param {boolean} nextEnabled
     */
    setEnabled(nextEnabled) {
      enabled = nextEnabled;
      if (!enabled) {
        store.clear();
      }
    },

    size() {
      return store.size;
    },

    clear() {
      store.clear();
    },

    isEnabled() {
      return enabled;
    },
  };
}

/** Process-wide default cache; enabled for non-test via configureProjectAclCache. */
export const projectAclCache = createProjectAclCache({ enabled: false });

/**
 * Invalidates every cached project ACL entry for an organization.
 * @param {string} orgId Tenant id.
 */
export function invalidateProjectAclCache(orgId) {
  projectAclCache.invalidateOrganization(orgId);
}

/**
 * Applies environment policy to the process-wide project ACL cache.
 * @param {{ isTest: boolean }} env Validated env flags from config.
 */
export function configureProjectAclCache(env) {
  projectAclCache.setEnabled(!env.isTest);
}

/**
 * Increments organization.aclVersion and invalidates the local project ACL cache.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<void>}
 */
export async function bumpProjectAclVersion(orgId, options = {}) {
  await bumpOrganizationAclVersion(orgId, options);
  invalidateProjectAclCache(String(orgId));
}

// --- from projectMembers/projectAccess.js ---
/**
 * Resolves effective project permissions (org roles ∪ project overlay).
 * Single source of truth for project visibility and ACL.
 */
/** Sentinel when the caller must not learn the project exists. */
export const PROJECT_ACL_NO_ACCESS = Object.freeze({ kind: /** @type {const} */ ('NO_ACCESS') });

/**
 * @typedef {{ kind: 'OK', visible: true, permissions: string[] }} ProjectAclOk
 * @typedef {{ kind: 'NO_ACCESS' }} ProjectAclNoAccess
 * @typedef {ProjectAclOk | ProjectAclNoAccess} ProjectAclResult
 */

/**
 * Filters overlay permission keys to the product catalog.
 * @param {unknown} permissions Raw permissions array.
 * @returns {string[]}
 */
function catalogPermissions(permissions) {
  if (!Array.isArray(permissions)) {
    return [];
  }
  return [
    ...new Set(
      permissions.filter((key) => typeof key === 'string' && isKnownPermissionKey(key)),
    ),
  ];
}

/**
 * Loads overlay permissions from an optional project member grant.
 * Foreign/missing roleId contributes no permissions (grants only; no throw).
 * @param {string} orgId Tenant id.
 * @param {import('mongoose').Document | null} member Active member row.
 * @returns {Promise<string[]>}
 */
async function overlayPermissionsFromMember(orgId, member) {
  if (!member) {
    return [];
  }
  const explicit = catalogPermissions(member.permissions);
  if (!member.roleId) {
    return explicit;
  }
  const fromRole = await resolveEffectivePermissions(orgId, [String(member.roleId)]);
  return [...new Set([...explicit, ...fromRole])];
}

/**
 * Computes project ACL without caching.
 * @param {string} orgId
 * @param {string} userId
 * @param {string} projectId
 * @returns {Promise<{ result: ProjectAclResult, aclVersion: number }>}
 */
async function computeProjectPermissions(orgId, userId, projectId) {
  const organization = await findOrganizationById(orgId);
  const aclVersion =
    organization && typeof organization.aclVersion === 'number' ? organization.aclVersion : 0;

  const project = await findProjectById(orgId, projectId);
  if (!project) {
    return { result: PROJECT_ACL_NO_ACCESS, aclVersion };
  }

  const user = await findUserById(orgId, userId);
  if (!user || user.userStatus !== 'active') {
    return { result: PROJECT_ACL_NO_ACCESS, aclVersion };
  }

  const projectAccessMode = user.projectAccessMode ?? 'selected';
  if (projectAccessMode === 'none') {
    return { result: PROJECT_ACL_NO_ACCESS, aclVersion };
  }

  const member = findActiveMemberOnProject(project, userId);

  if (projectAccessMode === 'selected' && !member) {
    return { result: PROJECT_ACL_NO_ACCESS, aclVersion };
  }

  // 'all' is visible even without a member row; optional overlay may still grant extras.
  const roleIds = (user.roleIds ?? []).map((id) => String(id));
  const orgPermissions = await resolveEffectivePermissions(orgId, roleIds);
  const overlayPermissions = await overlayPermissionsFromMember(orgId, member);
  const permissions = [...new Set([...orgPermissions, ...overlayPermissions])];

  return {
    result: { kind: 'OK', visible: true, permissions },
    aclVersion,
  };
}

/**
 * Resolves whether a user may see a project and which permissions apply.
 * @param {string} orgId Tenant id (from principal).
 * @param {string} userId Caller user id.
 * @param {string} projectId Project id.
 * @param {{
 *   cache?: typeof projectAclCache,
 *   requestMemo?: Map<string, ProjectAclResult>,
 * }} [options] Cache / per-request memo overrides.
 * @returns {Promise<ProjectAclResult>}
 */
export async function resolveProjectPermissions(orgId, userId, projectId, options = {}) {
  const cache = options.cache ?? projectAclCache;
  const memoKey = `${orgId}:${userId}:${projectId}`;
  if (options.requestMemo?.has(memoKey)) {
    return /** @type {ProjectAclResult} */ (options.requestMemo.get(memoKey));
  }

  const organization = await findOrganizationById(orgId);
  const aclVersion =
    organization && typeof organization.aclVersion === 'number' ? organization.aclVersion : 0;

  const cached = cache.get(orgId, userId, projectId, aclVersion);
  if (cached) {
    /** @type {ProjectAclResult} */
    const fromCache =
      cached.kind === 'NO_ACCESS'
        ? PROJECT_ACL_NO_ACCESS
        : { kind: 'OK', visible: true, permissions: [...(cached.permissions ?? [])] };
    options.requestMemo?.set(memoKey, fromCache);
    return fromCache;
  }

  const { result, aclVersion: computedVersion } = await computeProjectPermissions(
    orgId,
    userId,
    projectId,
  );

  cache.set(orgId, userId, projectId, {
    kind: result.kind,
    permissions: result.kind === 'OK' ? result.permissions : undefined,
    aclVersion: computedVersion,
  });
  options.requestMemo?.set(memoKey, result);
  return result;
}

/**
 * Builds the accessible-project filter for GET /projects list.
 * @param {string} orgId Tenant id.
 * @param {string} userId Caller user id.
 * @returns {Promise<
 *   | { mode: 'all' }
 *   | { mode: 'none' }
 *   | { mode: 'selected', projectIds: string[] }
 * >}
 */
export async function resolveAccessibleProjectFilter(orgId, userId) {
  const user = await findUserById(orgId, userId);
  if (!user || user.userStatus !== 'active') {
    return { mode: 'none' };
  }
  const projectAccessMode = user.projectAccessMode ?? 'selected';
  if (projectAccessMode === 'none') {
    return { mode: 'none' };
  }
  if (projectAccessMode === 'all') {
    return { mode: 'all' };
  }
  const projectIds = await listAccessibleProjectIdsForUser(orgId, userId);
  if (projectIds.length === 0) {
    return { mode: 'none' };
  }
  return { mode: 'selected', projectIds };
}

// --- from projectMembers/projectMembers.repository.js ---
/**
 * Project member overlay on `projects.members[]`.
 */
/**
 * Builds a member subdocument for $push or create.
 * @param {{
 *   userId: import('mongoose').Types.ObjectId | string,
 *   roleId?: import('mongoose').Types.ObjectId | string | null,
 *   permissions?: string[],
 *   addedByUserId: import('mongoose').Types.ObjectId | string,
 *   createdBy?: import('mongoose').Types.ObjectId | string | null,
 * }} input Member fields.
 * @returns {object}
 */
export function buildProjectMemberSubdoc(input) {
  const now = new Date();
  const actorId = new mongoose.Types.ObjectId(String(input.createdBy ?? input.addedByUserId));
  return {
    _id: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(String(input.userId)),
    roleId: input.roleId ? new mongoose.Types.ObjectId(String(input.roleId)) : null,
    permissions: input.permissions ?? [],
    addedByUserId: new mongoose.Types.ObjectId(String(input.addedByUserId)),
    status: ROW_STATUS_ACTIVE,
    createdBy: actorId,
    updatedBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Finds the active grant for a user on an already-loaded project.
 * @param {{ members?: object[] } | null | undefined} project Project document.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @returns {object | null}
 */
export function findActiveMemberOnProject(project, userId) {
  if (!project || !Array.isArray(project.members)) {
    return null;
  }
  const wanted = String(userId);
  return (
    project.members.find(
      (member) => String(member.userId) === wanted && member.status === ROW_STATUS_ACTIVE,
    ) ?? null
  );
}

/**
 * Finds an active project member by project and user.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<object | null>}
 */
export async function findActiveProjectMember(orgId, projectId, userId, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(userId)) {
    return null;
  }
  const project = await findProjectById(orgId, projectId, options);
  return findActiveMemberOnProject(project, userId);
}

/**
 * Finds a project member including soft-deleted grants (for reactivation).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {import('mongoose').Types.ObjectId | string} userId User id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<object | null>}
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
  const project = await findProjectById(orgId, projectId, options);
  if (!project || !Array.isArray(project.members)) {
    return null;
  }
  const wanted = String(userId);
  const matches = project.members.filter((member) => String(member.userId) === wanted);
  const active = matches.find((member) => member.status === ROW_STATUS_ACTIVE);
  if (active) {
    return active;
  }
  let newest = null;
  for (const member of matches) {
    if (!newest) {
      newest = member;
      continue;
    }
    const newestAt = newest.updatedAt instanceof Date ? newest.updatedAt.getTime() : 0;
    const memberAt = member.updatedAt instanceof Date ? member.updatedAt.getTime() : 0;
    if (memberAt > newestAt) {
      newest = member;
    }
  }
  return newest;
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
  const query = Project.find({
    orgId,
    members: {
      $elemMatch: {
        userId: new mongoose.Types.ObjectId(String(userId)),
        status: ROW_STATUS_ACTIVE,
      },
    },
  })
    .select({ _id: 1 })
    .lean();
  if (options.session) {
    query.session(options.session);
  }
  const rows = await query.exec();
  return rows.map((row) => String(row._id));
}

/**
 * Lists all active members for a project.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<object[]>}
 */
export async function listProjectMembers(orgId, projectId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return [];
  }
  const project = await findProjectById(orgId, projectId);
  if (!project || !Array.isArray(project.members)) {
    return [];
  }
  return [...project.members]
    .filter((member) => member.status === ROW_STATUS_ACTIVE)
    .sort((left, right) => {
      const leftAt = left.createdAt instanceof Date ? left.createdAt.getTime() : 0;
      const rightAt = right.createdAt instanceof Date ? right.createdAt.getTime() : 0;
      if (rightAt !== leftAt) {
        return rightAt - leftAt;
      }
      return String(right._id).localeCompare(String(left._id));
    });
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
 * @returns {Promise<object | null>}
 */
export async function createProjectMember(orgId, input, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(input.projectId) || !mongoose.isValidObjectId(input.userId)) {
    return null;
  }
  const subdoc = buildProjectMemberSubdoc(input);
  const userObjectId = new mongoose.Types.ObjectId(String(input.userId));
  const query = Project.updateOne(
    {
      _id: input.projectId,
      orgId,
      members: { $not: { $elemMatch: { userId: userObjectId, status: ROW_STATUS_ACTIVE } } },
    },
    { $push: { members: subdoc } },
  );
  if (options.session) {
    query.session(options.session);
  }
  const result = await query.exec();
  if (result.matchedCount === 0) {
    return null;
  }
  return subdoc;
}

/**
 * Reactivates a soft-deleted member and refreshes overlay fields.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} memberId Member subdocument _id.
 * @param {{
 *   roleId?: import('mongoose').Types.ObjectId | string | null,
 *   permissions?: string[],
 *   addedByUserId: import('mongoose').Types.ObjectId | string,
 *   updatedBy?: import('mongoose').Types.ObjectId | string | null,
 * }} patch Overlay and actor.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<object | null>}
 */
export async function reactivateProjectMember(orgId, memberId, patch, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(memberId)) {
    return null;
  }
  const memberObjectId = new mongoose.Types.ObjectId(memberId);
  const now = new Date();
  const query = Project.findOneAndUpdate(
    { orgId, members: { $elemMatch: { _id: memberObjectId, status: ROW_STATUS_DELETED } } },
    {
      $set: {
        'members.$[elem].status': ROW_STATUS_ACTIVE,
        'members.$[elem].roleId': patch.roleId ?? null,
        'members.$[elem].permissions': patch.permissions ?? [],
        'members.$[elem].addedByUserId': patch.addedByUserId,
        'members.$[elem].updatedBy': patch.updatedBy ?? patch.addedByUserId,
        'members.$[elem].updatedAt': now,
      },
    },
    {
      arrayFilters: [{ 'elem._id': memberObjectId, 'elem.status': ROW_STATUS_DELETED }],
      returnDocument: 'after',
    },
  );
  if (options.session) {
    query.session(options.session);
  }
  const project = await query.exec();
  if (!project || !Array.isArray(project.members)) {
    return null;
  }
  return project.members.find((member) => String(member._id) === String(memberId)) ?? null;
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
  if (!mongoose.isValidObjectId(projectId) || !mongoose.isValidObjectId(userId)) {
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
  }
  const now = new Date();
  const userObjectId = new mongoose.Types.ObjectId(String(userId));
  const query = Project.updateOne(
    {
      _id: projectId,
      orgId,
      members: { $elemMatch: { userId: userObjectId, status: ROW_STATUS_ACTIVE } },
    },
    {
      $set: {
        'members.$[elem].status': ROW_STATUS_DELETED,
        'members.$[elem].updatedBy': options.updatedBy ?? null,
        'members.$[elem].updatedAt': now,
      },
    },
    {
      arrayFilters: [{ 'elem.userId': userObjectId, 'elem.status': ROW_STATUS_ACTIVE }],
    },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

// --- from projectMembers/projectMembers.service.js ---
/**
 * Project members use cases — add/remove with audit and ACL invalidation.
 */
/**
 * Maps a project member grant to the API shape.
 * @param {object} member Member subdocument.
 * @returns {object}
 */
export function mapProjectMemberToDto(member) {
  return {
    id: String(member._id),
    userId: String(member.userId),
    roleId: member.roleId ? String(member.roleId) : null,
    permissions: Array.isArray(member.permissions) ? [...member.permissions] : [],
    addedByUserId: String(member.addedByUserId),
    createdAt:
      member.createdAt instanceof Date
        ? member.createdAt.toISOString()
        : String(member.createdAt),
  };
}

/**
 * Validates POST body: roleId and/or catalog permissions required.
 * @param {{ roleId?: string | null, permissions?: string[] }} input Body fields.
 * @returns {{ roleId: string | null, permissions: string[] }}
 */
function normalizeMemberOverlay(input) {
  const roleId = input.roleId ? String(input.roleId) : null;
  const permissions = Array.isArray(input.permissions)
    ? [...new Set(input.permissions.map(String))]
    : [];

  if (!roleId && permissions.length === 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'body',
          message: 'At least one of roleId or permissions is required',
        },
      ],
    });
  }

  const unknown = permissions.filter((key) => !isKnownPermissionKey(key));
  if (unknown.length > 0) {
    throw ApiError.fromCode('UNKNOWN_PERMISSION', {
      details: { unknownKeys: unknown },
    });
  }

  return { roleId, permissions };
}

/**
 * Lists project members (ids only).
 * @param {string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @returns {Promise<{ items: object[] }>}
 */
export async function listMembers(orgId, projectId) {
  const rows = await listProjectMembers(orgId, projectId);
  return {
    items: rows.map((row) => mapProjectMemberToDto(row)),
  };
}

/**
 * Adds or reactivates a project member (idempotent on active row).
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   projectId: string,
 *   userId: string,
 *   roleId?: string | null,
 *   permissions?: string[],
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Add inputs.
 * @returns {Promise<{ member: object, created: boolean }>}
 */
export async function addProjectMember(input) {
  const project = await findProjectById(input.orgId, input.projectId);
  if (!project) {
    throw ApiError.fromCode('PROJECT_NOT_FOUND');
  }

  const targetUser = await findUserById(input.orgId, input.userId);
  if (!targetUser) {
    throw ApiError.fromCode('USER_NOT_FOUND');
  }

  const overlay = normalizeMemberOverlay({
    roleId: input.roleId,
    permissions: input.permissions,
  });

  if (overlay.roleId) {
    const role = await findRoleById(input.orgId, overlay.roleId);
    if (!role) {
      throw ApiError.fromCode('ROLE_NOT_FOUND');
    }
  }

  const active = findActiveMemberOnProject(project, input.userId);
  if (active) {
    return { member: mapProjectMemberToDto(active), created: false };
  }

  const existing = await findProjectMemberIncludingDeleted(
    input.orgId,
    input.projectId,
    input.userId,
  );

  const member =
    existing && existing.status === 'D'
      ? await reactivateProjectMember(input.orgId, String(existing._id), {
          roleId: overlay.roleId,
          permissions: overlay.permissions,
          addedByUserId: input.actorUserId,
          updatedBy: input.actorUserId,
        })
      : await createProjectMember(input.orgId, {
          projectId: input.projectId,
          userId: input.userId,
          roleId: overlay.roleId,
          permissions: overlay.permissions,
          addedByUserId: input.actorUserId,
          createdBy: input.actorUserId,
        });

  if (!member) {
    throw ApiError.fromCode('INTERNAL_ERROR');
  }

  await bumpProjectAclVersion(input.orgId);

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'project.member_added',
      resourceType: 'project',
      resourceId: input.projectId,
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        targetUserId: String(input.userId),
        roleId: overlay.roleId,
        permissions: overlay.permissions,
        memberId: String(member._id),
      },
    },
    { log: input.log },
  );

  return { member: mapProjectMemberToDto(member), created: true };
}

/**
 * Soft-deletes a project member.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   projectId: string,
 *   userId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Remove inputs.
 * @returns {Promise<void>}
 */
export async function removeProjectMember(input) {
  const project = await findProjectById(input.orgId, input.projectId);
  if (!project) {
    throw ApiError.fromCode('PROJECT_NOT_FOUND');
  }

  const active = findActiveMemberOnProject(project, input.userId);
  if (!active) {
    throw ApiError.fromCode('MEMBER_NOT_FOUND');
  }

  const result = await softDeleteProjectMember(
    input.orgId,
    input.projectId,
    input.userId,
    { updatedBy: input.actorUserId },
  );
  if (!result.matchedCount) {
    throw ApiError.fromCode('MEMBER_NOT_FOUND');
  }

  await bumpProjectAclVersion(input.orgId);

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'project.member_removed',
      resourceType: 'project',
      resourceId: input.projectId,
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        targetUserId: String(input.userId),
        memberId: String(active._id),
        permissions: Array.isArray(active.permissions) ? [...active.permissions] : [],
        roleId: active.roleId ? String(active.roleId) : null,
      },
    },
    { log: input.log },
  );
}

// --- from projectMembers/projectMembers.routes.js ---
/**
 * Project members HTTP routes under `/api/v1`.
 */
const projectIdParamsSchema = z.object({
  projectId: z.string().min(1),
});

const memberUserParamsSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
});

const emptyQuerySchema = z.object({}).strict();

const addBodySchema = z
  .object({
    userId: z.string().min(1),
    roleId: z.string().min(1).nullable().optional(),
    permissions: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      for (const key of issue.keys) {
        details.push({ path: String(key), message: 'Unrecognized key' });
      }
      continue;
    }
    details.push({
      path: issue.path.join('.') || 'body',
      message: issue.message,
    });
  }
  return details;
}

/**
 * Shared request context for member services.
 * @param {import('fastify').FastifyRequest} request Request.
 */
function serviceContext(request) {
  const audit = buildAuditContextFromRequest(request);
  return {
    orgId: /** @type {string} */ (request.principal.orgId),
    actorUserId: /** @type {string} */ (request.principal.userId),
    correlationId: audit.correlationId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    log: request.log,
  };
}

/** Members manage: projects.update on the project OR org-level users.manage. */
const requireMembersManage = requireProjectPermission(
  ['projects.update', 'users.manage'],
  { mode: 'any' },
);

/**
 * Registers project member routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function projectMemberRoutes(app) {
  app.get(
    '/projects/:projectId/members',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireMembersManage,
    },
    async (request) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const query = emptyQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(query.error) });
      }
      return listMembers(request.principal.orgId, params.data.projectId);
    },
  );

  app.post(
    '/projects/:projectId/members',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireMembersManage,
    },
    async (request, reply) => {
      const params = projectIdParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const parsed = addBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
      }
      const ctx = serviceContext(request);
      const result = await addProjectMember({
        ...ctx,
        projectId: params.data.projectId,
        userId: parsed.data.userId,
        roleId: parsed.data.roleId,
        permissions: parsed.data.permissions,
      });
      return reply.code(result.created ? 201 : 200).send(result.member);
    },
  );

  app.delete(
    '/projects/:projectId/members/:userId',
    {
      config: { routeAccess: 'authenticated' },
      preHandler: requireMembersManage,
    },
    async (request, reply) => {
      const params = memberUserParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
      }
      const ctx = serviceContext(request);
      await removeProjectMember({
        ...ctx,
        projectId: params.data.projectId,
        userId: params.data.userId,
      });
      return reply.code(204).send();
    },
  );
}

