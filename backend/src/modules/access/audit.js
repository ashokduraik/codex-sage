/**
 * access/audit.js — merged resource file.
 */
import { AuditEvent } from '../../models/audit.model.js';
import { User } from '../../models/user.model.js';
import { assertOrgId, decodeCursor, encodeCursor, includeDeleted } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import mongoose from 'mongoose';
import { z } from 'zod';

// --- from audit/audit.actions.js ---
/**
 * Curated audit action catalog — free-text actions are rejected at write time.
 * Later phases add entries in the same change that introduces their routes.
 */

/** @typedef {'user' | 'role' | 'membership' | 'route' | 'project' | 'job' | 'source' | 'knowledge' | 'repository' | 'conversation'} AuditResourceType */

/**
 * Map of known `<domain>.<verb>` actions to their paired resourceType.
 * @type {Readonly<Record<string, AuditResourceType>>}
 */
export const AUDIT_ACTION_RESOURCE_TYPES = Object.freeze({
  'user.create': 'user',
  'user.update': 'user',
  'user.email_changed': 'user',
  'user.activate': 'user',
  'user.deactivate': 'user',
  'user.remove': 'user',
  'user.roles_changed': 'user',
  'user.password_changed': 'user',
  'user.password_set_by_admin': 'user',
  'role.create': 'role',
  'role.update': 'role',
  'role.remove': 'role',
  'membership.update': 'membership',
  'authz.denied': 'route',
  'project.create': 'project',
  'project.update': 'project',
  'project.settings_changed': 'project',
  'project.archive': 'project',
  'project.restore': 'project',
  'project.delete': 'project',
  'project.member_added': 'project',
  'project.member_removed': 'project',
  'job.retry': 'job',
  'job.cancel': 'job',
  'source.upload': 'source',
  'knowledge.completed': 'knowledge',
  'knowledge.failed': 'knowledge',
  'repository.connected': 'repository',
  'repository.branch_changed': 'repository',
  'repository.credential_replaced': 'repository',
  'repository.credential_revoked': 'repository',
  'repository.sync_triggered': 'repository',
  'conversation.created': 'conversation',
  'conversation.archived': 'conversation',
  'conversation.restored': 'conversation',
  'conversation.deleted': 'conversation',
  'conversation.title_changed': 'conversation',
});

/** Frozen list of known action strings. */
export const AUDIT_ACTIONS = Object.freeze(Object.keys(AUDIT_ACTION_RESOURCE_TYPES));

/** Set for O(1) membership checks. */
const AUDIT_ACTION_SET = new Set(AUDIT_ACTIONS);

/**
 * Returns whether `action` is a known catalog entry.
 * @param {string} action Candidate action.
 * @returns {boolean}
 */
export function isKnownAuditAction(action) {
  return typeof action === 'string' && AUDIT_ACTION_SET.has(action);
}

/**
 * Returns the resourceType paired with a known action.
 * @param {string} action Catalog action.
 * @returns {AuditResourceType | undefined}
 */
export function resourceTypeForAction(action) {
  return AUDIT_ACTION_RESOURCE_TYPES[action];
}

// --- from audit/audit.sanitizer.js ---
/**
 * Allowlist sanitizer for audit `context` and `userAgent` (backend §87, §148).
 */

/** Cap on JSON-serialized context bytes. */
export const AUDIT_CONTEXT_MAX_BYTES = 4096;

/** Cap on a single context string value (characters). */
export const AUDIT_CONTEXT_MAX_VALUE_CHARS = 512;

/** Truncation length for User-Agent headers. */
export const AUDIT_USER_AGENT_MAX_CHARS = 256;

/**
 * Forbidden key substrings (case-insensitive). Matching keys become `'[redacted]'`.
 */
const FORBIDDEN_KEY_SUBSTRINGS = Object.freeze([
  'password',
  'token',
  'secret',
  'credential',
  'authorization',
  'apikey',
  'privatekey',
  'cookie',
  'hash',
]);

/**
 * Returns whether a value is an allowed scalar for audit context.
 * @param {unknown} value Candidate value.
 * @returns {boolean}
 */
function isAllowedScalar(value) {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean';
}

/**
 * Truncates a string to max characters.
 * @param {string} value Source string.
 * @param {number} maxChars Max length.
 * @returns {{ value: string, truncated: boolean }}
 */
function truncateString(value, maxChars) {
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, maxChars), truncated: true };
}

/**
 * Sanitizes optional User-Agent header text.
 * @param {unknown} userAgent Raw header.
 * @returns {string | undefined}
 */
export function sanitizeUserAgent(userAgent) {
  if (typeof userAgent !== 'string' || userAgent.length === 0) {
    return undefined;
  }
  return truncateString(userAgent, AUDIT_USER_AGENT_MAX_CHARS).value;
}

/**
 * Sanitizes audit context: allowlist scalars / depth-1 scalar arrays; redact secrets;
 * enforce size caps. Nested objects and functions are dropped.
 * @param {unknown} context Caller-supplied metadata.
 * @returns {Record<string, unknown> | undefined}
 */
export function sanitizeAuditContext(context) {
  if (context === undefined || context === null) {
    return undefined;
  }
  if (typeof context !== 'object' || Array.isArray(context)) {
    return undefined;
  }

  /** @type {Record<string, unknown>} */
  const out = {};
  let truncated = false;

  for (const [key, raw] of Object.entries(context)) {
    if (typeof key !== 'string' || key.length === 0) {
      continue;
    }
    if (FORBIDDEN_KEY_SUBSTRINGS.some((fragment) => key.toLowerCase().includes(fragment))) {
      out[key] = '[redacted]';
      continue;
    }
    if (Array.isArray(raw)) {
      /** @type {Array<string | number | boolean>} */
      const items = [];
      for (const item of raw) {
        if (!isAllowedScalar(item)) {
          truncated = true;
          continue;
        }
        if (typeof item === 'string') {
          const next = truncateString(item, AUDIT_CONTEXT_MAX_VALUE_CHARS);
          items.push(next.value);
          if (next.truncated) {
            truncated = true;
          }
        } else {
          items.push(item);
        }
      }
      out[key] = items;
      continue;
    }
    if (!isAllowedScalar(raw)) {
      // Nested objects, functions, null, symbols — drop (do not store).
      truncated = true;
      continue;
    }
    if (typeof raw === 'string') {
      const next = truncateString(raw, AUDIT_CONTEXT_MAX_VALUE_CHARS);
      out[key] = next.value;
      if (next.truncated) {
        truncated = true;
      }
    } else {
      out[key] = raw;
    }
  }

  if (truncated) {
    out.contextTruncated = true;
  }

  let serialized = JSON.stringify(out);
  if (Buffer.byteLength(serialized, 'utf8') > AUDIT_CONTEXT_MAX_BYTES) {
    out.contextTruncated = true;
    // Drop non-essential keys until under the byte cap (keep redaction markers).
    const keys = Object.keys(out).filter((key) => key !== 'contextTruncated');
    while (keys.length > 0 && Buffer.byteLength(JSON.stringify(out), 'utf8') > AUDIT_CONTEXT_MAX_BYTES) {
      const dropKey = keys.pop();
      if (dropKey) {
        delete out[dropKey];
      }
    }
    serialized = JSON.stringify(out);
    if (Buffer.byteLength(serialized, 'utf8') > AUDIT_CONTEXT_MAX_BYTES) {
      return { contextTruncated: true };
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

// --- from audit/audit.repository.js ---
/**
 * AuditEvent repository — insert and org-scoped keyset list only.
 */
/** Default page size for GET /audit-events. */
export const AUDIT_LIST_PAGE_SIZE_DEFAULT = 50;

/** Hard cap on `limit` query parameter. */
export const AUDIT_LIST_PAGE_SIZE_MAX = 200;

/**
 * Inserts one audit event document.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   actorUserId?: import('mongoose').Types.ObjectId | string | null,
 *   action: string,
 *   resourceType: string,
 *   resourceId?: string | null,
 *   result: 'success' | 'denied' | 'failed',
 *   correlationId: string,
 *   ip?: string | null,
 *   userAgent?: string | null,
 *   context?: Record<string, unknown> | null,
 * }} fields Sanitized audit fields.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function insertAuditEvent(fields) {
  assertOrgId(fields.orgId);
  const [doc] = await AuditEvent.create([
    {
      orgId: fields.orgId,
      actorUserId: fields.actorUserId ?? undefined,
      action: fields.action,
      resourceType: fields.resourceType,
      resourceId: fields.resourceId ?? undefined,
      result: fields.result,
      correlationId: fields.correlationId,
      ip: fields.ip ?? undefined,
      userAgent: fields.userAgent ?? undefined,
      context: fields.context ?? undefined,
    },
  ]);
  return doc;
}

/**
 * Clamps a requested page size into the allowed range.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampAuditListLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return AUDIT_LIST_PAGE_SIZE_DEFAULT;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return AUDIT_LIST_PAGE_SIZE_DEFAULT;
  }
  return Math.min(Math.floor(parsed), AUDIT_LIST_PAGE_SIZE_MAX);
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
 * Lists audit events for an organization with optional filters and keyset pagination.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id (always injected).
 * @param {{
 *   from?: Date,
 *   to?: Date,
 *   actor?: string,
 *   action?: string,
 *   resourceType?: string,
 *   cursor?: string,
 *   limit?: number,
 * }} [filters] List filters.
 * @returns {Promise<{
 *   items: import('mongoose').Document[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }>}
 */
export async function listAuditEvents(orgId, filters = {}) {
  assertOrgId(orgId);
  const limit = clampAuditListLimit(filters.limit);
  /** @type {Record<string, unknown>} */
  const query = { orgId };

  if (filters.from instanceof Date && !Number.isNaN(filters.from.getTime())) {
    query.createdAt = {
      ...(typeof query.createdAt === 'object' && query.createdAt !== null ? /** @type {object} */ (query.createdAt) : {}),
      $gte: filters.from,
    };
  }
  if (filters.to instanceof Date && !Number.isNaN(filters.to.getTime())) {
    query.createdAt = {
      ...(typeof query.createdAt === 'object' && query.createdAt !== null ? /** @type {object} */ (query.createdAt) : {}),
      $lt: filters.to,
    };
  }
  if (filters.actor) {
    if (!mongoose.isValidObjectId(filters.actor)) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: [{ path: 'actor', message: 'actor must be a valid ObjectId' }],
      });
    }
    query.actorUserId = filters.actor;
  }
  if (filters.action) {
    query.action = filters.action;
  }
  if (filters.resourceType) {
    query.resourceType = filters.resourceType;
  }

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
    const keyset = keysetAfterFilter(decoded);
    Object.assign(query, {
      $and: [keyset],
    });
  }

  const rows = await AuditEvent.find(query)
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
 * Finds one audit event by id within an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} auditEventId Event id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findAuditEventById(orgId, auditEventId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(auditEventId)) {
    return null;
  }
  return AuditEvent.findOne({ _id: auditEventId, orgId }).exec();
}

// --- from audit/audit.service.js ---
/**
 * Audit service — best-effort writer and org-scoped list/detail.
 */
/** Permission keys whose 403 denials are audited (admin/security surface). */
export const AUDITED_DENIAL_PERMISSION_KEYS = Object.freeze(['users.manage', 'roles.manage', 'settings.manage', 'audit.view']);

/**
 * Logs an audit insert failure without throwing.
 * @param {{ error?: Function } | undefined} log Optional logger.
 * @param {string | undefined} correlationId Request/job correlation id.
 * @param {unknown} err Failure.
 */
function logAuditWriteFailure(log, correlationId, err) {
  const payload = {
    correlationId,
    err: err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) },
  };
  if (typeof log?.error === 'function') {
    log.error(payload, 'audit write failed');
    return;
  }
  console.error(JSON.stringify({ level: 'error', msg: 'audit write failed', ...payload }));
}

/**
 * Extracts org/actor/correlation/ip/ua from an authenticated Fastify request.
 * Returns data only — never writes to `reply`.
 * @param {import('fastify').FastifyRequest} request Incoming request.
 * @returns {{
 *   orgId: string | undefined,
 *   actorUserId: string | undefined,
 *   correlationId: string,
 *   ip: string | undefined,
 *   userAgent: string | undefined,
 * }}
 */
export function buildAuditContextFromRequest(request) {
  const principal = /** @type {{ orgId?: string, userId?: string } | null | undefined} */ (request.principal);
  const rawUa = request.headers?.['user-agent'];
  return {
    orgId: principal?.orgId,
    actorUserId: principal?.userId,
    correlationId: request.id,
    ip: request.ip,
    userAgent: sanitizeUserAgent(typeof rawUa === 'string' ? rawUa : undefined),
  };
}

/**
 * Returns whether a permission denial should write an audit row.
 * @param {string[]} requiredPermissions Route required permissions.
 * @returns {boolean}
 */
export function shouldAuditAuthorizationDenial(requiredPermissions) {
  if (!Array.isArray(requiredPermissions) || requiredPermissions.length === 0) {
    return false;
  }
  const audited = new Set(AUDITED_DENIAL_PERMISSION_KEYS);
  return requiredPermissions.some((key) => audited.has(key));
}

/**
 * Best-effort audit writer: never throws; logs insert failures at error.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   actorUserId?: import('mongoose').Types.ObjectId | string | null,
 *   action: string,
 *   resourceType?: string,
 *   resourceId?: string | null,
 *   result: 'success' | 'denied' | 'failed',
 *   correlationId: string,
 *   ip?: string | null,
 *   userAgent?: string | null,
 *   context?: Record<string, unknown> | null,
 * }} input Event fields.
 * @param {{ log?: { error?: Function } }} [options] Optional logger.
 * @returns {Promise<void>}
 */
export async function recordAuditEvent(input, options = {}) {
  try {
    if (!input?.orgId) {
      throw new Error('orgId is required');
    }
    if (!input.correlationId) {
      throw new Error('correlationId is required');
    }
    if (!input.action || !isKnownAuditAction(input.action)) {
      throw new Error(`unknown audit action: ${input?.action}`);
    }
    const expectedType = resourceTypeForAction(input.action);
    const resourceType = input.resourceType ?? expectedType;
    if (!resourceType) {
      throw new Error('resourceType is required');
    }
    if (expectedType && resourceType !== expectedType) {
      throw new Error(`resourceType ${resourceType} does not match action ${input.action}`);
    }
    if (!['success', 'denied', 'failed'].includes(input.result)) {
      throw new Error('result must be success, denied, or failed');
    }

    await insertAuditEvent({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: input.action,
      resourceType,
      resourceId: input.resourceId,
      result: input.result,
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: sanitizeUserAgent(input.userAgent),
      context: sanitizeAuditContext(input.context ?? undefined),
    });
  } catch (err) {
    logAuditWriteFailure(options.log, input?.correlationId, err);
  }
}

/**
 * Loads actors by id including soft-deleted users (history must keep the email).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string[]} userIds Actor ids.
 * @returns {Promise<Map<string, { id: string, email: string }>>}
 */
async function loadActorsById(orgId, userIds) {
  /** @type {Map<string, { id: string, email: string }>} */
  const map = new Map();
  const unique = [...new Set(userIds.filter((id) => mongoose.isValidObjectId(id)))];
  if (unique.length === 0) {
    return map;
  }
  const query = User.find({
    orgId,
    _id: { $in: unique },
  }).select({ email: 1 });
  includeDeleted(query);
  const users = await query.exec();
  for (const user of users) {
    map.set(String(user._id), { id: String(user._id), email: user.email });
  }
  return map;
}

/**
 * Maps an audit document to the API item shape.
 * @param {import('mongoose').Document} doc Audit document.
 * @param {Map<string, { id: string, email: string }>} actors Actor lookup.
 * @returns {object}
 */
function toAuditEventDto(doc, actors) {
  const actorId = doc.actorUserId ? String(doc.actorUserId) : null;
  const actor = actorId ? (actors.get(actorId) ?? { id: actorId, email: null }) : null;
  return {
    id: String(doc._id),
    action: doc.action,
    resourceType: doc.resourceType,
    resourceId: doc.resourceId ?? null,
    result: doc.result,
    actor,
    correlationId: doc.correlationId,
    ip: doc.ip ?? null,
    userAgent: doc.userAgent ?? null,
    context: doc.context ?? null,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
  };
}

/**
 * Lists audit events for the caller's organization with actor enrichment.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {object} filters Repository filters.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listAuditEventsForOrg(orgId, filters = {}) {
  const { items, pageInfo } = await listAuditEvents(orgId, filters);
  const actorIds = items.map((doc) => (doc.actorUserId ? String(doc.actorUserId) : null)).filter(Boolean);
  const actors = await loadActorsById(orgId, /** @type {string[]} */ (actorIds));
  return {
    items: items.map((doc) => toAuditEventDto(doc, actors)),
    pageInfo,
  };
}

/**
 * Loads one audit event for the caller's organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} auditEventId Event id.
 * @returns {Promise<object>}
 * @throws {ApiError} NOT_FOUND when missing or cross-tenant.
 */
export async function getAuditEventForOrg(orgId, auditEventId) {
  const doc = await findAuditEventById(orgId, auditEventId);
  if (!doc) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  const actorIds = doc.actorUserId ? [String(doc.actorUserId)] : [];
  const actors = await loadActorsById(orgId, actorIds);
  return toAuditEventDto(doc, actors);
}

// --- from audit/audit.routes.js ---
/**
 * Audit event HTTP routes — list and detail (append-only; no writes).
 */
const listQuerySchema = z
  .object({
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    actor: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    resourceType: z.string().min(1).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

const idParamsSchema = z.object({
  auditEventId: z.string().min(1),
});

/**
 * Parses an optional ISO-8601 UTC instant.
 * @param {string | undefined} value Raw query value.
 * @param {string} path Field path for errors.
 * @returns {Date | undefined}
 */
function parseOptionalInstant(value, path) {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path, message: `${path} must be a valid ISO-8601 instant` }],
    });
  }
  return date;
}

/**
 * Registers `GET /audit-events` and `GET /audit-events/:auditEventId`.
 * @param {import('fastify').FastifyInstance} app Fastify app.
 */
export async function auditRoutes(app) {
  app.get(
    '/audit-events',
    {
      config: {
        requiredPermissions: ['audit.view'],
      },
    },
    async (request) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'query',
            message: issue.message,
          })),
        });
      }

      if (parsed.data.action && !isKnownAuditAction(parsed.data.action)) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'action', message: 'unknown audit action' }],
        });
      }
      if (parsed.data.actor && !mongoose.isValidObjectId(parsed.data.actor)) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: [{ path: 'actor', message: 'actor must be a valid ObjectId' }],
        });
      }

      const principal = request.principal;
      return listAuditEventsForOrg(principal.orgId, {
        from: parseOptionalInstant(parsed.data.from, 'from'),
        to: parseOptionalInstant(parsed.data.to, 'to'),
        actor: parsed.data.actor,
        action: parsed.data.action,
        resourceType: parsed.data.resourceType,
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      });
    },
  );

  app.get(
    '/audit-events/:auditEventId',
    {
      config: {
        requiredPermissions: ['audit.view'],
      },
    },
    async (request) => {
      const params = idParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        throw ApiError.fromCode('VALIDATION_ERROR', {
          details: params.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'auditEventId',
            message: issue.message,
          })),
        });
      }
      const principal = request.principal;
      return getAuditEventForOrg(principal.orgId, params.data.auditEventId);
    },
  );
}

export { AuditEvent } from '../../models/audit.model.js';
export const AUDIT_MODELS = Object.freeze([AuditEvent]);
