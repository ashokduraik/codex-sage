/**
 * Role service — list, create, update, soft-delete with catalog and built-in guards.
 */
import { ApiError } from '../../platform/errors.js';
import { isKnownPermissionKey } from '../authorization/permissionCatalog.js';
import { invalidateRole } from '../authorization/roleCache.js';
import { recordAuditEvent } from '../audit/index.js';
import { mapRoleToDto } from './identity.mappers.js';
import { isRoleReferencedByActiveMembership } from './membership.repository.js';
import {
  createRole as createRoleInRepo,
  findRoleById,
  listRolesPage,
  softDeleteRole as softDeleteRoleInRepo,
  updateRole as updateRoleInRepo,
} from './role.repository.js';

/**
 * Rejects permission keys absent from the Phase 09 catalog.
 * @param {string[]} permissions Candidate keys.
 * @throws {ApiError} UNKNOWN_PERMISSION
 */
export function assertKnownPermissions(permissions) {
  const unknown = permissions.filter((key) => !isKnownPermissionKey(key));
  if (unknown.length > 0) {
    throw ApiError.fromCode('UNKNOWN_PERMISSION', {
      details: { unknown },
    });
  }
}

/**
 * Lists roles with keyset pagination.
 * @param {string} orgId Tenant id.
 * @param {{ cursor?: string, limit?: number }} filters List filters.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listRolesForOrg(orgId, filters = {}) {
  const page = await listRolesPage(orgId, filters);
  return {
    items: page.items.map((role) => mapRoleToDto(role)),
    pageInfo: page.pageInfo,
  };
}

/**
 * Creates a custom role.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   name: string,
 *   description?: string,
 *   permissions: string[],
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Create inputs.
 * @returns {Promise<object>} Role DTO.
 */
export async function createRole(input) {
  assertKnownPermissions(input.permissions);
  const created = await createRoleInRepo(input.orgId, {
    name: input.name,
    description: input.description,
    permissions: input.permissions,
    createdBy: input.actorUserId,
    updatedBy: input.actorUserId,
  });

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'role.create',
      resourceType: 'role',
      resourceId: String(created._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { name: created.name, permissions: created.permissions },
    },
    { log: input.log },
  );

  return mapRoleToDto(created);
}

/**
 * Updates a role (built-in: description only).
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   roleId: string,
 *   name?: string,
 *   description?: string,
 *   permissions?: string[],
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Update inputs.
 * @returns {Promise<object>} Role DTO.
 */
export async function updateRole(input) {
  if (input.permissions) {
    assertKnownPermissions(input.permissions);
  }
  const updated = await updateRoleInRepo(
    input.orgId,
    input.roleId,
    {
      name: input.name,
      description: input.description,
      permissions: input.permissions,
    },
    { updatedBy: input.actorUserId },
  );

  if (!updated.isBuiltIn) {
    invalidateRole(String(input.orgId), String(input.roleId));
  }

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'role.update',
      resourceType: 'role',
      resourceId: String(updated._id),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: {
        name: updated.name,
        isBuiltIn: updated.isBuiltIn,
        permissions: updated.isBuiltIn ? undefined : updated.permissions,
      },
    },
    { log: input.log },
  );

  return mapRoleToDto(updated);
}

/**
 * Soft-deletes a custom role when unused.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   roleId: string,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Delete inputs.
 * @returns {Promise<void>}
 */
export async function softDeleteRole(input) {
  const role = await findRoleById(input.orgId, input.roleId);
  if (!role) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Role not found.' });
  }
  if (role.isBuiltIn) {
    throw ApiError.fromCode('BUILT_IN_ROLE_IMMUTABLE');
  }
  if (await isRoleReferencedByActiveMembership(input.orgId, input.roleId)) {
    throw ApiError.fromCode('ROLE_IN_USE');
  }

  await softDeleteRoleInRepo(input.orgId, input.roleId, {
    updatedBy: input.actorUserId,
  });
  invalidateRole(String(input.orgId), String(input.roleId));

  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'role.remove',
      resourceType: 'role',
      resourceId: String(input.roleId),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      context: { name: role.name },
    },
    { log: input.log },
  );
}
