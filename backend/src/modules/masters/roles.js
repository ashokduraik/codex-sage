/**
 * masters/roles.js — merged resource file.
 */
import { BUILT_IN_ROLES, Role } from '../../models/role.model.js';
import { assertOrgId, decodeCursor, encodeCursor, softDelete } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import { getBuiltInRolePermissions, isKnownPermissionKey, invalidateRole, recordAuditEvent, buildAuditContextFromRequest } from '../access/index.js';
import { bumpProjectAclVersion } from './projectMembers.js';
import { isRoleReferencedByActiveUser } from './users.js';
import { z } from 'zod';
import mongoose from 'mongoose';

const IDENTITY_LIST_PAGE_SIZE_DEFAULT = 25;

/**
 * Clamps a requested role list page size.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
function clampIdentityListLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return IDENTITY_LIST_PAGE_SIZE_DEFAULT;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'limit', message: 'limit must be a positive integer' }],
    });
  }
  return Math.min(Math.floor(parsed), 100);
}

// --- from identity/role.repository.js ---
/**
 * Role repository — tenant-scoped; built-in roles allow description-only edits.
 */
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
  const limit = clampIdentityListLimit(filters.limit === undefined ? IDENTITY_LIST_PAGE_SIZE_DEFAULT : filters.limit);
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
export async function createRoleInRepo(orgId, input, options = {}) {
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
export async function softDeleteRoleInRepo(orgId, roleId, options = {}) {
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
  return softDelete(Role, { _id: roleId, orgId }, { updatedBy: options.updatedBy ?? null, session: options.session });
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
export async function updateRoleInRepo(orgId, roleId, patch, options = {}) {
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
    const touchesImmutable = patch.name !== undefined || patch.permissions !== undefined;
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
  return typeof err === 'object' && err !== null && /** @type {{ code?: number }} */ (err).code === 11000;
}

// --- from identity/role.service.js ---
/**
 * Role service — list, create, update, soft-delete with catalog and built-in guards.
 */
/**
 * Maps a role document (and optional code-resolved permissions) to a DTO.
 * @param {object} role Role document or lean object.
 * @returns {{
 *   id: string,
 *   name: string,
 *   description: string | null,
 *   permissions: string[],
 *   isBuiltIn: boolean,
 *   createdAt: string,
 * }}
 */
export function mapRoleToDto(role) {
  let permissions = Array.isArray(role.permissions) ? [...role.permissions] : [];
  if (role.isBuiltIn && role.builtInKey) {
    const fromCode = getBuiltInRolePermissions(role.builtInKey);
    if (fromCode) {
      permissions = [...fromCode];
    }
  }
  return {
    id: String(role._id ?? role.id),
    name: role.name,
    description: role.description ?? null,
    permissions,
    isBuiltIn: Boolean(role.isBuiltIn),
    createdAt: role.createdAt instanceof Date ? role.createdAt.toISOString() : String(role.createdAt ?? ''),
  };
}

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
  const mongoSession = await mongoose.startSession();
  /** @type {import('mongoose').Document | undefined} */
  let updated;
  try {
    await mongoSession.withTransaction(async () => {
      updated = await updateRoleInRepo(
        input.orgId,
        input.roleId,
        {
          name: input.name,
          description: input.description,
          permissions: input.permissions,
        },
        { updatedBy: input.actorUserId, session: mongoSession },
      );
      await bumpProjectAclVersion(input.orgId, { session: mongoSession });
    });
  } finally {
    await mongoSession.endSession();
  }
  if (!updated) {
    throw ApiError.fromCode('INTERNAL_ERROR');
  }

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
  if (await isRoleReferencedByActiveUser(input.orgId, input.roleId)) {
    throw ApiError.fromCode('ROLE_IN_USE');
  }

  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      await softDeleteRoleInRepo(input.orgId, input.roleId, {
        updatedBy: input.actorUserId,
        session: mongoSession,
      });
      await bumpProjectAclVersion(input.orgId, { session: mongoSession });
    });
  } finally {
    await mongoSession.endSession();
  }
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

const objectIdStringSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, 'must be a 24-char hex ObjectId');

const createRoleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    permissions: z.array(z.string().min(1)).min(1),
  })
  .strict();

const patchRoleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    permissions: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.description !== undefined || body.permissions !== undefined, {
    message: 'at least one of name, description, permissions is required',
  });

const listRolesQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

const roleIdParamsSchema = z.object({ roleId: objectIdStringSchema });

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function zodDetails(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || 'body',
    message: issue.message,
  }));
}

/**
 * Shared request context for role services.
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

/**
 * Registers role admin routes under `/api/v1`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function roleRoutes(app) {
  app.get('/roles', { config: { requiredPermissions: ['roles.manage'] } }, async (request) => {
    const parsed = listRolesQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
    }
    if (parsed.data.limit === 0) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: [{ path: 'limit', message: 'limit must be a positive integer' }],
      });
    }
    return listRolesForOrg(request.principal.orgId, parsed.data);
  });

  app.post('/roles', { config: { requiredPermissions: ['roles.manage'] } }, async (request, reply) => {
    const parsed = createRoleBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
    }
    const ctx = serviceContext(request);
    const role = await createRole({
      ...ctx,
      name: parsed.data.name,
      description: parsed.data.description,
      permissions: parsed.data.permissions,
    });
    return reply.code(201).send(role);
  });

  app.patch('/roles/:roleId', { config: { requiredPermissions: ['roles.manage'] } }, async (request) => {
    const params = roleIdParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
    }
    const parsed = patchRoleBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
    }
    const ctx = serviceContext(request);
    return updateRole({
      ...ctx,
      roleId: params.data.roleId,
      name: parsed.data.name,
      description: parsed.data.description,
      permissions: parsed.data.permissions,
    });
  });

  app.delete('/roles/:roleId', { config: { requiredPermissions: ['roles.manage'] } }, async (request, reply) => {
    const params = roleIdParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
    }
    const ctx = serviceContext(request);
    await softDeleteRole({ ...ctx, roleId: params.data.roleId });
    return reply.code(204).send();
  });
}
