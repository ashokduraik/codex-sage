/**
 * AuditEvent repository — insert and org-scoped keyset list only.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import {
  assertOrgId,
  decodeCursor,
  encodeCursor,
} from '../../platform/data/index.js';
import { AuditEvent } from './audit.model.js';

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
    $or: [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: id } },
    ],
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
      ...(typeof query.createdAt === 'object' && query.createdAt !== null
        ? /** @type {object} */ (query.createdAt)
        : {}),
      $gte: filters.from,
    };
  }
  if (filters.to instanceof Date && !Number.isNaN(filters.to.getTime())) {
    query.createdAt = {
      ...(typeof query.createdAt === 'object' && query.createdAt !== null
        ? /** @type {object} */ (query.createdAt)
        : {}),
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
