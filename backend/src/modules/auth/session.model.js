/**
 * Session Mongoose model — rotating refresh-token families.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

/** Reasons a session (or family) may be revoked. */
export const SESSION_REVOKED_REASONS = Object.freeze([
  'logout',
  'reuse_detected',
  'password_changed',
  'user_disabled',
]);

const sessionSchema = createBaseSchema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  familyId: {
    type: String,
    required: true,
    trim: true,
  },
  refreshTokenHash: {
    type: String,
    required: true,
  },
  issuedAt: {
    type: Date,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  rotatedAt: {
    type: Date,
    default: undefined,
  },
  replacedBySessionId: {
    type: mongoose.Schema.Types.ObjectId,
    default: undefined,
  },
  revokedAt: {
    type: Date,
    default: undefined,
  },
  revokedReason: {
    type: String,
    enum: SESSION_REVOKED_REASONS,
    default: undefined,
  },
});

sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
sessionSchema.index({ orgId: 1, userId: 1, status: 1 });
sessionSchema.index({ familyId: 1 });
sessionSchema.index({ expiresAt: 1 });
sessionSchema.index(
  { _id: 1, status: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const Session =
  mongoose.models.Session ?? mongoose.model('Session', sessionSchema, 'sessions');
