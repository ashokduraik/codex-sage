/**
 * Audit service — best-effort writer and org-scoped list/detail.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import { getCorrelationId } from '../../platform/requestContext.js';
import { includeDeleted } from '../../platform/data/index.js';
import { User } from '../identity/user.model.js';
import { isKnownAuditAction, resourceTypeForAction } from './audit.actions.js';
import {
  findAuditEventById,
  insertAuditEvent,
  listAuditEvents as listAuditEventsFromRepo,
} from './audit.repository.js';
import { sanitizeAuditContext, sanitizeUserAgent } from './audit.sanitizer.js';

/** Permission keys whose 403 denials are audited (admin/security surface). */
export const AUDITED_DENIAL_PERMISSION_KEYS = Object.freeze([
  'users.manage',
  'roles.manage',
  'settings.manage',
  'audit.view',
]);

/**
 * Logs an audit insert failure without throwing.
 * @param {{ error?: Function } | undefined} log Optional logger.
 * @param {string | undefined} correlationId Request/job correlation id.
 * @param {unknown} err Failure.
 */
function logAuditWriteFailure(log, correlationId, err) {
  const payload = {
    correlationId: correlationId ?? getCorrelationId(),
    err:
      err instanceof Error
        ? { name: err.name, message: err.message }
        : { message: String(err) },
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
  const principal = /** @type {{ orgId?: string, userId?: string } | null | undefined} */ (
    request.principal
  );
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
      throw new Error(
        `resourceType ${resourceType} does not match action ${input.action}`,
      );
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
  const actor = actorId ? actors.get(actorId) ?? { id: actorId, email: null } : null;
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
    createdAt:
      doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
  };
}

/**
 * Lists audit events for the caller's organization with actor enrichment.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {object} filters Repository filters.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listAuditEventsForOrg(orgId, filters = {}) {
  const { items, pageInfo } = await listAuditEventsFromRepo(orgId, filters);
  const actorIds = items
    .map((doc) => (doc.actorUserId ? String(doc.actorUserId) : null))
    .filter(Boolean);
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
