/**
 * IdempotencyRecord Mongoose model — Mongo-backed keys shared across PM2 workers/hosts.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../data/index.js';

/** Domain lifecycle for an idempotency claim (separate from row status). */
export const IDEMPOTENCY_RECORD_STATE_VALUES = Object.freeze(['processing', 'completed']);

const idempotencyRecordSchema = createBaseSchema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  route: {
    type: String,
    required: true,
    trim: true,
    maxlength: 256,
  },
  key: {
    type: String,
    required: true,
    trim: true,
    maxlength: 128,
  },
  requestHash: {
    type: String,
    required: true,
    trim: true,
  },
  recordState: {
    type: String,
    enum: IDEMPOTENCY_RECORD_STATE_VALUES,
    required: true,
    default: 'processing',
  },
  responseStatus: {
    type: Number,
    default: null,
  },
  responseBody: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  resourceId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
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
