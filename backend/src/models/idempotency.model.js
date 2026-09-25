/**
 * `idempotencyRecords` — replay-safe claims for mutating API requests, shared
 * across workers so a retried request returns the original result.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

/** Domain lifecycle for an idempotency claim (separate from row status). */
export const IDEMPOTENCY_RECORD_STATE_VALUES = Object.freeze(['processing', 'completed']);

const idempotencyRecordSchema = createBaseSchema({
  // Caller whose idempotency key this claim belongs to
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Route the key applies to so keys do not collide across endpoints
  route: { type: String, required: true, trim: true, maxlength: 256 },
  // Client-supplied idempotency key
  key: { type: String, required: true, trim: true, maxlength: 128 },
  // Hash of the original request so a replay with a different body is rejected
  requestHash: { type: String, required: true, trim: true },
  // Whether the first request is still running or the stored response is ready
  recordState: { type: String, enum: IDEMPOTENCY_RECORD_STATE_VALUES, required: true, default: 'processing' },
  // HTTP status to replay once the first request completes
  responseStatus: { type: Number, default: null },
  // Response body to replay once the first request completes
  responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
  // Created resource id, when the original request created one
  resourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // When Mongo may expire this claim
  expiresAt: { type: Date, required: true },
});

idempotencyRecordSchema.index(
  { orgId: 1, userId: 1, route: 1, key: 1 },
  { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyRecord =
  mongoose.models.IdempotencyRecord ??
  mongoose.model('IdempotencyRecord', idempotencyRecordSchema, 'idempotencyRecords');

/** Models whose indexes must be synced for this platform concern. */
export const IDEMPOTENCY_MODELS = Object.freeze([IdempotencyRecord]);
