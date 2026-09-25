/**
 * `sessions` — keeps Alice signed in after login. Each row is one
 * refresh token. When she gets a new token, this row is marked rotated
 * and a new row is created. If an old token is used again (stolen),
 * every token from that login (`familyId`) is revoked.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** Why a token (or its whole login family) was invalidated. */
export const SESSION_REVOKED_REASONS = Object.freeze([
  'logout',
  'reuse_detected',
  'password_changed',
  'user_disabled',
  'email_changed',
]);

const sessionSchema = createBaseSchema({
  // User who is signed in (Alice)
  userId: { type: ObjectId, ref: 'User', required: true },
  // Groups every token from one login. Logout or theft kills all of them
  familyId: { type: String, required: true, trim: true },
  // Stored refresh token (never the raw token)
  refreshTokenHash: { type: String, required: true },
  // When this token was issued
  issuedAt: { type: Date, required: true },
  // When this token stops being accepted
  expiresAt: { type: Date, required: true },
  // When this token was replaced by a newer one
  rotatedAt: { type: Date, default: undefined },
  // The newer session row that replaced this token
  replacedBySessionId: { type: ObjectId, ref: 'Session', default: undefined },
  // When this token (or its whole family) was invalidated
  revokedAt: { type: Date, default: undefined },
  // Why: logout, stolen-token reuse, password/email change, or account disabled
  revokedReason: { type: String, enum: SESSION_REVOKED_REASONS, default: undefined },
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
