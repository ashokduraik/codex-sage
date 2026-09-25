/**
 * Project members use cases — add/remove with audit and ACL invalidation.
 */
import { ApiError } from '../../platform/errors.js';
import { isKnownPermissionKey } from '../authorization/permissionCatalog.js';
import { recordAuditEvent } from '../audit/index.js';
import { findRoleById } from '../identity/role.repository.js';
import { findUserById } from '../identity/user.repository.js';
import { findProjectById } from '../projects/projects.repository.js';
import { bumpProjectAclVersion } from './projectAclCache.js';
import {
  createProjectMember,
  findActiveProjectMember,
  findProjectMemberIncludingDeleted,
  listProjectMembers,
  reactivateProjectMember,
  softDeleteProjectMember,
} from './projectMembers.repository.js';

/**
 * Maps a ProjectMember document to the API shape.
 * @param {import('mongoose').Document} member Member row.
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
 * @param {{ cursor?: string, limit?: number }} [filters] Pagination.
 * @returns {Promise<{ items: object[], nextCursor: string | null }>}
 */
export async function listMembers(orgId, projectId, filters = {}) {
  const page = await listProjectMembers(orgId, projectId, filters);
  return {
    items: page.items.map((row) => mapProjectMemberToDto(row)),
    nextCursor: page.nextCursor,
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

  const active = await findActiveProjectMember(
    input.orgId,
    input.projectId,
    input.userId,
  );
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

  const active = await findActiveProjectMember(
    input.orgId,
    input.projectId,
    input.userId,
  );
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

/**
 * Ensures the project creator has an active ProjectMember row (for selected mode).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   userId: string,
 *   session?: import('mongoose').ClientSession,
 * }} input Creator seed inputs.
 * @returns {Promise<void>}
 */
export async function ensureCreatorProjectMember(input) {
  const active = await findActiveProjectMember(
    input.orgId,
    input.projectId,
    input.userId,
    { session: input.session },
  );
  if (active) {
    return;
  }
  const existing = await findProjectMemberIncludingDeleted(
    input.orgId,
    input.projectId,
    input.userId,
    { session: input.session },
  );
  if (existing && existing.status === 'D') {
    await reactivateProjectMember(
      input.orgId,
      String(existing._id),
      {
        roleId: null,
        permissions: [],
        addedByUserId: input.userId,
        updatedBy: input.userId,
      },
      { session: input.session },
    );
  } else {
    await createProjectMember(
      input.orgId,
      {
        projectId: input.projectId,
        userId: input.userId,
        roleId: null,
        permissions: [],
        addedByUserId: input.userId,
        createdBy: input.userId,
      },
      { session: input.session },
    );
  }
  await bumpProjectAclVersion(input.orgId, { session: input.session });
}
