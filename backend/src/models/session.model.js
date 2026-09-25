/**
 * `sessions` — rotating refresh-token families that keep a user signed in.
 * Reuse or revoke of one token can invalidate the whole family.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

/** Reasons a session (or family) may be revoked. */
export const SESSION_REVOKED_REASONS = Object.freeze([
  'logout',
  'reuse_detected',
  'password_changed',
  'user_disabled',
  'email_changed',
]);

const sessionSchema = createBaseSchema({
  // User this refresh-token session belongs to
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Rotation family so reuse of an old token can revoke the whole chain
  familyId: { type: String, required: true, trim: true },
  // Hash of the current refresh token (never the raw token)
  refreshTokenHash: { type: String, required: true },
  // When this session row was created
  issuedAt: { type: Date, required: true },
  // When the refresh token stops being accepted
  expiresAt: { type: Date, required: true },
  // When this token was rotated to a successor session
  rotatedAt: { type: Date, default: undefined },
  // Session that replaced this one after rotation
  replacedBySessionId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
  // When the session or family was revoked
  revokedAt: { type: Date, default: undefined },
  // Why the session was revoked (logout, reuse, password or email change, disable)
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
