/**
 * Persistence helpers for idempotency records.
 */
import mongoose from 'mongoose';
import { assertOrgId, softDelete } from '../data/index.js';
import { IdempotencyRecord } from '../../models/idempotency.model.js';

/** How long an idempotency record remains usable for replay. */
export const IDEMPOTENCY_RECORD_TTL_MS = 86_400_000;

/** How long a duplicate waiter polls for the first writer's result. */
export const IDEMPOTENCY_WAIT_MS = 5_000;

/** Poll interval while waiting for an in-flight twin. */
export const IDEMPOTENCY_POLL_INTERVAL_MS = 100;

/**
 * Returns whether an error is a Mongo duplicate-key failure.
 * @param {unknown} err Candidate error.
 * @returns {boolean}
 */
export function isMongoDuplicateKeyError(err) {
  return typeof err === 'object' && err !== null && /** @type {{ code?: number }} */ (err).code === 11000;
}

/**
 * Builds the unique route label for an idempotency record.
 * @param {string} method HTTP method.
 * @param {string} pathTemplate Fastify route path template.
 * @returns {string}
 */
export function buildIdempotencyRouteLabel(method, pathTemplate) {
  return `${String(method).toUpperCase()} ${pathTemplate}`;
}

/**
 * Finds an active, non-expired idempotency record.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   userId: string | import('mongoose').Types.ObjectId,
 *   route: string,
 *   key: string,
 * }} query Scope keys.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findActiveIdempotencyRecord(query) {
  assertOrgId(query.orgId);
  const now = new Date();
  return IdempotencyRecord.findOne({
    orgId: query.orgId,
    userId: query.userId,
    route: query.route,
    key: query.key,
    expiresAt: { $gt: now },
  }).exec();
}

/**
 * Soft-deletes an expired-but-still-active row so a new claim can insert.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   userId: string | import('mongoose').Types.ObjectId,
 *   route: string,
 *   key: string,
 * }} query Scope keys.
 * @returns {Promise<void>}
 */
export async function releaseExpiredIdempotencyRecord(query) {
  assertOrgId(query.orgId);
  const now = new Date();
  await softDelete(IdempotencyRecord, {
    orgId: query.orgId,
    userId: query.userId,
    route: query.route,
    key: query.key,
    expiresAt: { $lte: now },
  });
}

/**
 * Inserts a processing claim. On unique conflict returns the existing active row.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   userId: string | import('mongoose').Types.ObjectId,
 *   route: string,
 *   key: string,
 *   requestHash: string,
 *   createdBy?: string | import('mongoose').Types.ObjectId | null,
 * }} input Claim fields.
 * @returns {Promise<{ owned: boolean, record: import('mongoose').Document }>}
 */
export async function beginIdempotencyClaim(input) {
  assertOrgId(input.orgId);
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_RECORD_TTL_MS);
  const doc = {
    orgId: input.orgId,
    userId: input.userId,
    route: input.route,
    key: input.key,
    requestHash: input.requestHash,
    recordState: 'processing',
    responseStatus: null,
    responseBody: null,
    resourceId: null,
    expiresAt,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
  };

  try {
    const [created] = await IdempotencyRecord.create([doc]);
    return { owned: true, record: created };
  } catch (err) {
    if (!isMongoDuplicateKeyError(err)) {
      throw err;
    }
  }

  let existing = await findActiveIdempotencyRecord(input);
  if (!existing) {
    await releaseExpiredIdempotencyRecord(input);
    try {
      const [created] = await IdempotencyRecord.create([doc]);
      return { owned: true, record: created };
    } catch (retryErr) {
      if (!isMongoDuplicateKeyError(retryErr)) {
        throw retryErr;
      }
      existing = await findActiveIdempotencyRecord(input);
    }
  }

  if (!existing) {
    throw new Error('idempotency claim conflict without an active record');
  }
  return { owned: false, record: existing };
}

/**
 * Marks a processing record completed with the successful response payload.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   recordId: string | import('mongoose').Types.ObjectId,
 *   responseStatus: number,
 *   responseBody: unknown,
 *   resourceId?: string | import('mongoose').Types.ObjectId | null,
 *   updatedBy?: string | import('mongoose').Types.ObjectId | null,
 * }} input Completion fields.
 * @returns {Promise<void>}
 */
export async function completeIdempotencyRecord(input) {
  assertOrgId(input.orgId);
  /** @type {Record<string, unknown>} */
  const set = {
    recordState: 'completed',
    responseStatus: input.responseStatus,
    responseBody: input.responseBody,
    updatedBy: input.updatedBy ?? null,
    updatedAt: new Date(),
  };
  if (input.resourceId) {
    set.resourceId = new mongoose.Types.ObjectId(String(input.resourceId));
  }
  await IdempotencyRecord.updateOne(
    {
      _id: input.recordId,
      orgId: input.orgId,
      recordState: 'processing',
    },
    { $set: set },
  ).exec();
}

/**
 * Soft-deletes a processing claim so the same key may be retried after failure.
 * @param {{
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   recordId: string | import('mongoose').Types.ObjectId,
 *   updatedBy?: string | import('mongoose').Types.ObjectId | null,
 * }} input Release fields.
 * @returns {Promise<void>}
 */
export async function releaseIdempotencyClaim(input) {
  assertOrgId(input.orgId);
  await softDelete(
    IdempotencyRecord,
    {
      _id: input.recordId,
      orgId: input.orgId,
      recordState: 'processing',
    },
    { updatedBy: input.updatedBy ?? null },
  );
}
