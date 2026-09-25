/**
 * Role repository — tenant-scoped; built-in roles allow description-only edits.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import {
  assertOrgId,
  decodeCursor,
  encodeCursor,
  softDelete,
} from '../../platform/data/index.js';
import { BUILT_IN_ROLES, Role } from './role.model.js';
import {
  IDENTITY_LIST_PAGE_SIZE_DEFAULT,
  clampIdentityListLimit,
} from './user.repository.js';

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
    $or: [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: id } },
    ],
  };
}

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
 * Finds an active role by org and id.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} roleId Role id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findRoleById(orgId, roleId, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(roleId)) {
    return null;
  }
  const query = Role.findOne({ _id: roleId, orgId });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Finds active roles by ids within an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {Array<import('mongoose').Types.ObjectId | string>} roleIds Role ids.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function findRolesByIds(orgId, roleIds, options = {}) {
  assertOrgId(orgId);
  const ids = roleIds.filter((id) => mongoose.isValidObjectId(id));
  if (ids.length === 0) {
    return [];
  }
  const query = Role.find({ _id: { $in: ids }, orgId });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Lists active roles for an organization (name sort — legacy callers).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function listRoles(orgId) {
  assertOrgId(orgId);
  return Role.find({ orgId }).sort({ name: 1 }).exec();
}

/**
 * Lists active roles with keyset pagination.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{ cursor?: string, limit?: number }} [filters] List filters.
 * @returns {Promise<{
 *   items: import('mongoose').Document[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }>}
 */
export async function listRolesPage(orgId, filters = {}) {
  assertOrgId(orgId);
  const limit = clampIdentityListLimit(
    filters.limit === undefined ? IDENTITY_LIST_PAGE_SIZE_DEFAULT : filters.limit,
  );
  /** @type {Record<string, unknown>} */
  const query = { orgId };

  if (filters.cursor) {
    let decoded;
    try {
      decoded = decodeCursor(filters.cursor);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CURSOR') {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'cursor', message: 'cursor is malformed' }],
        });
      }
      throw err;
    }
    Object.assign(query, { $and: [keysetAfterFilter(decoded)] });
  }

  const rows = await Role.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  /** @type {string | null} */
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      t: last.createdAt.toISOString(),
      i: String(last._id),
    });
  }

  return {
    items,
    pageInfo: { nextCursor, hasMore },
  };
}

/**
 * Creates a custom role in an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   name: string,
 *   description?: string,
 *   permissions: string[],
 *   createdBy?: import('mongoose').Types.ObjectId | string | null,
 *   updatedBy?: import('mongoose').Types.ObjectId | string | null,
 * }} input Role fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createRole(orgId, input, options = {}) {
  assertOrgId(orgId);
  try {
    const [created] = await Role.create(
      [
        {
          orgId,
          name: input.name,
          description: input.description,
          isBuiltIn: false,
          permissions: input.permissions ?? [],
          createdBy: input.createdBy ?? null,
          updatedBy: input.updatedBy ?? null,
        },
      ],
      options.session ? { session: options.session } : undefined,
    );
    return created;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw ApiError.fromCode('IDENTITY_DUPLICATE_ROLE_NAME');
    }
    throw err;
  }
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
 * @param {{
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 *   session?: import('mongoose').ClientSession,
 * }} [options] Actor stamp and session.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteRole(orgId, roleId, options = {}) {
  assertOrgId(orgId);
  const query = Role.findOne({ _id: roleId, orgId });
  if (options.session) {
    query.session(options.session);
  }
  const role = await query.exec();
  if (!role) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Role not found.' });
  }
  if (role.isBuiltIn) {
    throw ApiError.fromCode('BUILT_IN_ROLE_IMMUTABLE');
  }
  return softDelete(
    Role,
    { _id: roleId, orgId },
    { updatedBy: options.updatedBy ?? null, session: options.session },
  );
}

/**
 * Updates a role. Built-ins may change description only.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} roleId Role id.
 * @param {{ name?: string, permissions?: string[], description?: string }} patch Fields.
 * @param {{
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 *   session?: import('mongoose').ClientSession,
 * }} [options] Actor stamp and session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function updateRole(orgId, roleId, patch, options = {}) {
  assertOrgId(orgId);
  const query = Role.findOne({ _id: roleId, orgId });
  if (options.session) {
    query.session(options.session);
  }
  const role = await query.exec();
  if (!role) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Role not found.' });
  }
  if (role.isBuiltIn) {
    const touchesImmutable =
      patch.name !== undefined || patch.permissions !== undefined;
    if (touchesImmutable) {
      throw ApiError.fromCode('BUILT_IN_ROLE_IMMUTABLE');
    }
    if (patch.description === undefined) {
      return role;
    }
    role.description = patch.description;
    role.updatedBy = options.updatedBy ?? null;
    await role.save(options.session ? { session: options.session } : undefined);
    return role;
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
  try {
    await role.save(options.session ? { session: options.session } : undefined);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw ApiError.fromCode('IDENTITY_DUPLICATE_ROLE_NAME');
    }
    throw err;
  }
  return role;
}

/**
 * @param {unknown} err Driver / Mongoose error.
 * @returns {boolean}
 */
export function isDuplicateKeyError(err) {
  return (
    typeof err === 'object' &&
    err !== null &&
    /** @type {{ code?: number }} */ (err).code === 11000
  );
}
