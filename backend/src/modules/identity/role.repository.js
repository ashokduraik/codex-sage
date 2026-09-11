/**
 * Role repository — tenant-scoped; built-in roles are immutable outside the seed path.
 */
import { ApiError } from '../../platform/errors.js';
import { assertOrgId, softDelete } from '../../platform/data/index.js';
import { BUILT_IN_ROLES } from './builtInRoles.js';
import { Role } from './role.model.js';

/**
 * Finds a built-in role by org and key.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} builtInKey Built-in role key.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findBuiltInRole(orgId, builtInKey, options = {}) {
  assertOrgId(orgId);
  const query = Role.findOne({ orgId, isBuiltIn: true, builtInKey });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Lists active roles for an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function listRoles(orgId) {
  assertOrgId(orgId);
  return Role.find({ orgId }).sort({ name: 1 }).exec();
}

/**
 * Ensures the four built-in roles exist for an organization (seed path).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   session?: import('mongoose').ClientSession,
 *   onStep?: (detail: { key: string, created: boolean }) => void,
 * }} [options] Session and optional step callback.
 * @returns {Promise<{ roles: import('mongoose').Document[], createdCount: number }>}
 */
export async function ensureBuiltInRoles(orgId, options = {}) {
  assertOrgId(orgId);
  const roles = [];
  let createdCount = 0;
  for (const definition of BUILT_IN_ROLES) {
    let role = await findBuiltInRole(orgId, definition.key, {
      session: options.session,
    });
    let created = false;
    if (!role) {
      try {
        const [createdRole] = await Role.create(
          [
            {
              orgId,
              name: definition.name,
              description: definition.description,
              isBuiltIn: true,
              builtInKey: definition.key,
              permissions: [],
              createdBy: null,
              updatedBy: null,
            },
          ],
          options.session ? { session: options.session } : undefined,
        );
        role = createdRole;
        created = true;
        createdCount += 1;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          role = await findBuiltInRole(orgId, definition.key, {
            session: options.session,
          });
        } else {
          throw err;
        }
      }
    }
    options.onStep?.({ key: definition.key, created });
    if (!role) {
      throw ApiError.fromCode('BOOTSTRAP_FAILED', {
        message: `Built-in role ${definition.key} could not be ensured.`,
      });
    }
    roles.push(role);
  }
  return { roles, createdCount };
}

/**
 * Soft-deletes a custom role. Built-in roles are rejected.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} roleId Role id.
 * @param {{ updatedBy?: import('mongoose').Types.ObjectId | null }} [options] Actor stamp.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteRole(orgId, roleId, options = {}) {
  assertOrgId(orgId);
  const role = await Role.findOne({ _id: roleId, orgId });
  if (!role) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Role not found.' });
  }
  if (role.isBuiltIn) {
    throw ApiError.fromCode('FORBIDDEN', {
      message: 'Built-in roles cannot be soft-deleted.',
    });
  }
  return softDelete(
    Role,
    { _id: roleId, orgId },
    { updatedBy: options.updatedBy ?? null },
  );
}

/**
 * Updates a custom role name/permissions. Built-in roles are rejected.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} roleId Role id.
 * @param {{ name?: string, permissions?: string[], description?: string }} patch Fields.
 * @param {{ updatedBy?: import('mongoose').Types.ObjectId | null }} [options] Actor stamp.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function updateRole(orgId, roleId, patch, options = {}) {
  assertOrgId(orgId);
  const role = await Role.findOne({ _id: roleId, orgId });
  if (!role) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Role not found.' });
  }
  if (role.isBuiltIn) {
    throw ApiError.fromCode('FORBIDDEN', {
      message: 'Built-in roles cannot be renamed or re-permissioned.',
    });
  }
  if (patch.name !== undefined) {
    role.name = patch.name;
  }
  if (patch.permissions !== undefined) {
    role.permissions = patch.permissions;
  }
  if (patch.description !== undefined) {
    role.description = patch.description;
  }
  role.updatedBy = options.updatedBy ?? null;
  await role.save();
  return role;
}

/**
 * @param {unknown} err Driver / Mongoose error.
 * @returns {boolean}
 */
function isDuplicateKeyError(err) {
  return (
    typeof err === 'object' &&
    err !== null &&
    /** @type {{ code?: number }} */ (err).code === 11000
  );
}
