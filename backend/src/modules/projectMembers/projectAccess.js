/**
 * Resolves effective project permissions (org roles ∪ project overlay).
 * Single source of truth for project visibility and ACL.
 */
import { resolveEffectivePermissions } from '../authorization/permissionResolver.js';
import { isKnownPermissionKey } from '../authorization/permissionCatalog.js';
import { findMembership } from '../identity/membership.repository.js';
import { findOrganizationById } from '../identity/organization.repository.js';
import { findUserById } from '../identity/user.repository.js';
import { findProjectById } from '../projects/projects.repository.js';
import {
  findActiveProjectMember,
  listAccessibleProjectIdsForUser,
} from './projectMembers.repository.js';
import { projectAclCache } from './projectAclCache.js';

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
 * Loads overlay permissions from an optional ProjectMember row.
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

  const membership = await findMembership(orgId, userId);
  if (!membership) {
    return { result: PROJECT_ACL_NO_ACCESS, aclVersion };
  }

  const projectAccessMode = membership.projectAccessMode ?? 'selected';
  if (projectAccessMode === 'none') {
    return { result: PROJECT_ACL_NO_ACCESS, aclVersion };
  }

  const member = await findActiveProjectMember(orgId, projectId, userId);

  if (projectAccessMode === 'selected' && !member) {
    return { result: PROJECT_ACL_NO_ACCESS, aclVersion };
  }

  // 'all' is visible even without a member row; optional overlay may still grant extras.
  const roleIds = (membership.roleIds ?? []).map((id) => String(id));
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
  const membership = await findMembership(orgId, userId);
  if (!membership) {
    return { mode: 'none' };
  }
  const projectAccessMode = membership.projectAccessMode ?? 'selected';
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
