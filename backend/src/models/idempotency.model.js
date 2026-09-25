/**
 * `idempotencyRecords` — remembers a mutating request so a retry does
 * not run it twice. Example: POST Create user with Idempotency-Key
 * create-alice-001. The first call creates Alice and stores the 201
 * here; the same key again returns that stored body and does not
 * insert another Alice.
 *
 * These rows are not users or projects. They expire after 24 hours.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** processing = first request still running; completed = response stored. */
export const IDEMPOTENCY_RECORD_STATE_VALUES = Object.freeze(['processing', 'completed']);

const idempotencyRecordSchema = createBaseSchema({
  // Who sent the Idempotency-Key (Ashok). Same key from Bob is a different row
  userId: { type: ObjectId, ref: 'User', required: true },
  // Which endpoint the key is for. Same key on POST /users vs POST /projects
  // is two different rows
  route: { type: String, required: true, trim: true, maxlength: 256 },
  // Value from the Idempotency-Key header, e.g. create-alice-001
  key: { type: String, required: true, trim: true, maxlength: 128 },
  // Hash of the first request body. Same key with a different body is rejected
  requestHash: { type: String, required: true, trim: true },
  // processing = first request still running; completed = stored response ready
  recordState: { type: String, enum: IDEMPOTENCY_RECORD_STATE_VALUES, required: true, default: 'processing' },
  // HTTP status from the first request (e.g. 201), returned on retry
  responseStatus: { type: Number, default: null },
  // JSON body from the first request, returned on retry
  responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
  // Id of the object the first request created (Alice's user id)
  resourceId: { type: ObjectId, default: null },
  // When this row is deleted (24 hours). After that the same key is a new request
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

/** Models this file owns; used when syncing Mongo indexes. */
export const IDEMPOTENCY_MODELS = Object.freeze([IdempotencyRecord]);
