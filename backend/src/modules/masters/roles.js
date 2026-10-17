/**
 * masters/roles.js — merged resource file.
 */
import { z } from 'zod';
import mongoose from 'mongoose';
import { Role } from '../../models/role.model.js';
import { isRoleReferencedByActiveUser } from './users.js';
import { bumpProjectAclVersion } from './projectMembers.js';
import { ApiError, apiErrorFromCaught } from '../../platform/errors.js';
import { assertOrgId, decodeCursor, encodeCursor, includeDeleted, softDelete } from '../../platform/data/index.js';
import { ALL_PERMISSION_KEYS, isKnownPermissionKey, invalidateRole, recordAuditEvent, buildAuditContextFromRequest } from '../access/index.js';

const IDENTITY_LIST_PAGE_SIZE_DEFAULT = 25;

/** Seed sentinel and lookup key for the organization administrator role. */
export const ADMIN_ROLE_CODE = 'ADMIN';

/** Display name written when seed creates the administrator role. */
export const ADMIN_ROLE_NAME = 'Org Admin';

/** Identity `code` pattern shared with the Role schema. */
const MASTER_CODE_PATTERN = /^[A-Z0-9_-]{2,64}$/;

// --- from identity/role.repository.js ---
/**
 * Role repository — tenant-scoped; every role stores its own permissions.
 */
/**
 * Finds a role by org and identity code.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} code Identity code (compared uppercase).
 * @param {{
 *   session?: import('mongoose').ClientSession,
 *   includeDeleted?: boolean,
 * }} [options] Session and whether to include soft-deleted rows.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findRoleByCode(orgId, code, options = {}) {
  assertOrgId(orgId);
  const query = Role.findOne({ orgId, code: String(code).toUpperCase() });
  if (options.includeDeleted) {
    includeDeleted(query);
  }
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
 * @param {{ q?: string, cursor?: string, limit?: number }} [filters] List filters.
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

  if (filters.q && String(filters.q).trim().length > 0) {
    const fragment = String(filters.q)
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(fragment, 'i');
    query.$or = [{ name: pattern }, { code: pattern }, { description: pattern }];
  }

  if (filters.cursor) {
    let decoded;
    try {
      decoded = decodeCursor(filters.cursor);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CURSOR') {
        throw apiErrorFromCaught('VALIDATION_ERROR', err, {
          details: [{ path: 'cursor', message: 'cursor is malformed' }],
          logLevel: 'warn',
          logMessage: 'role list cursor malformed',
        });
      }
      throw err;
    }
    const keyset = keysetAfterFilter(decoded);
    if (query.$or) {
      query.$and = [{ $or: query.$or }, keyset];
      delete query.$or;
    } else {
      Object.assign(query, { $and: [keyset] });
    }
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
 * Creates a role in an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   code: string,
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
          code: String(input.code).toUpperCase(),
          name: input.name,
          description: input.description,
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
      throw apiErrorFromCaught(duplicateKeyField(err) === 'code' ? 'IDENTITY_DUPLICATE_ROLE_CODE' : 'IDENTITY_DUPLICATE_ROLE_NAME', err, {
        logLevel: 'warn',
        logMessage: 'role create conflict',
      });
    }
    throw err;
  }
}

/**
 * Ensures the ADMIN role exists unless it was previously created (including soft-deleted).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   session?: import('mongoose').ClientSession,
 *   onStep?: (detail: { code: string, created: boolean }) => void,
 * }} [options] Session and optional step callback.
 * @returns {Promise<{ role: import('mongoose').Document | null, created: boolean }>}
 */
export async function ensureAdminRole(orgId, options = {}) {
  assertOrgId(orgId);
  const existing = await findRoleByCode(orgId, ADMIN_ROLE_CODE, { session: options.session });
  if (existing) {
    options.onStep?.({ code: ADMIN_ROLE_CODE, created: false });
    return { role: existing, created: false };
  }
  const previouslyCreated = await findRoleByCode(orgId, ADMIN_ROLE_CODE, {
    session: options.session,
    includeDeleted: true,
  });
  if (previouslyCreated) {
    options.onStep?.({ code: ADMIN_ROLE_CODE, created: false });
    return { role: null, created: false };
  }
  try {
    const created = await createRoleInRepo(
      orgId,
      {
        code: ADMIN_ROLE_CODE,
        name: ADMIN_ROLE_NAME,
        description: 'Full organization administration.',
        permissions: [...ALL_PERMISSION_KEYS],
        createdBy: null,
        updatedBy: null,
      },
      { session: options.session },
    );
    options.onStep?.({ code: ADMIN_ROLE_CODE, created: true });
    return { role: created, created: true };
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'IDENTITY_DUPLICATE_ROLE_CODE' || err.code === 'IDENTITY_DUPLICATE_ROLE_NAME')) {
      const raced = await findRoleByCode(orgId, ADMIN_ROLE_CODE, { session: options.session });
      options.onStep?.({ code: ADMIN_ROLE_CODE, created: false });
      return { role: raced, created: false };
    }
    throw err;
  }
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
  return softDelete(Role, { _id: roleId, orgId }, { updatedBy: options.updatedBy ?? null, session: options.session });
}

/**
 * Updates a role. `code` is never writable here.
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
      throw apiErrorFromCaught(duplicateKeyField(err) === 'code' ? 'IDENTITY_DUPLICATE_ROLE_CODE' : 'IDENTITY_DUPLICATE_ROLE_NAME', err, {
        logLevel: 'warn',
        logMessage: 'role update conflict',
      });
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

/**
 * Which unique field collided on a Mongo duplicate-key error.
 * @param {unknown} err Driver / Mongoose error.
 * @returns {'code' | 'name' | 'email' | 'slug' | null}
 */
export function duplicateKeyField(err) {
  if (!isDuplicateKeyError(err) || typeof err !== 'object' || err === null) {
    return null;
  }
  const record = /** @type {{ keyPattern?: Record<string, unknown>, keyValue?: Record<string, unknown> }} */ (err);
  const pattern = record.keyPattern ?? {};
  const keyValue = record.keyValue ?? {};
  if ('code' in pattern || 'code' in keyValue) {
    return 'code';
  }
  if ('name' in pattern || 'name' in keyValue) {
    return 'name';
  }
  if ('email' in pattern || 'email' in keyValue) {
    return 'email';
  }
  if ('slug' in pattern || 'slug' in keyValue) {
    return 'slug';
  }
  return null;
}

// --- from identity/role.service.js ---
/**
 * Role service — list, create, update, soft-delete with catalog validation.
 */
/**
 * Maps a role document to a DTO. Permissions come from the stored array.
 * @param {object} role Role document or lean object.
 * @returns {{
 *   id: string,
 *   code: string,
 *   name: string,
 *   description: string | null,
 *   permissions: string[],
 *   createdAt: string,
 * }}
 */
export function mapRoleToDto(role) {
  const stored = Array.isArray(role.permissions) ? role.permissions : [];
  return {
    id: String(role._id ?? role.id),
    code: typeof role.code === 'string' ? role.code : '',
    name: role.name,
    description: role.description ?? null,
    permissions: stored.filter((key) => typeof key === 'string' && isKnownPermissionKey(key)),
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
 * @param {{ q?: string, cursor?: string, limit?: number }} filters List filters.
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
 *   code: string,
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
    code: input.code,
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
      context: { code: created.code, name: created.name, permissions: created.permissions },
    },
    { log: input.log },
  );

  return mapRoleToDto(created);
}

/**
 * Updates a role name, description, or permissions. `code` is not accepted.
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

  invalidateRole(String(input.orgId), String(input.roleId));

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
        code: updated.code,
        name: updated.name,
        permissions: updated.permissions,
      },
    },
    { log: input.log },
  );

  return mapRoleToDto(updated);
}

/**
 * Soft-deletes a role when unused.
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
      context: { code: role.code, name: role.name },
    },
    { log: input.log },
  );
}

const objectIdStringSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, 'must be a 24-char hex ObjectId');

const identityCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => MASTER_CODE_PATTERN.test(value), { message: 'code must match [A-Z0-9_-]{2,64}' });

const createRoleBodySchema = z
  .object({
    code: identityCodeSchema,
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
    q: z.string().min(1).max(200).optional(),
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
 * GET /masters/roles/list — list org roles (admin).
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function listRolesHttp(request) {
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
}

/**
 * POST /masters/roles/create — create a custom org role (admin).
 * @param {import('fastify').FastifyRequest} request Request.
 * @param {import('fastify').FastifyReply} reply Reply.
 */
export async function createRoleHttp(request, reply) {
  const parsed = createRoleBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(parsed.error) });
  }
  const ctx = serviceContext(request);
  const role = await createRole({
    ...ctx,
    code: parsed.data.code,
    name: parsed.data.name,
    description: parsed.data.description,
    permissions: parsed.data.permissions,
  });
  return reply.code(201).send(role);
}

/**
 * PATCH /masters/roles/update/:roleId — update role metadata and permissions (admin).
 * @param {import('fastify').FastifyRequest} request Request.
 */
export async function updateRoleHttp(request) {
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
}

/**
 * DELETE /masters/roles/delete/:roleId — soft-delete a role (admin).
 * @param {import('fastify').FastifyRequest} request Request.
 * @param {import('fastify').FastifyReply} reply Reply.
 */
export async function deleteRoleHttp(request, reply) {
  const params = roleIdParamsSchema.safeParse(request.params ?? {});
  if (!params.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: zodDetails(params.error) });
  }
  const ctx = serviceContext(request);
  await softDeleteRole({ ...ctx, roleId: params.data.roleId });
  return reply.code(204).send();
}
