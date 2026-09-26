/**
 * `loginsessions` — one document per sign-in. Refresh rotations append
 * token entries. Reuse of an old hash, or logout, kills this login.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** Non-logout kills of the whole login. Logout uses loggedOutAt only. */
export const LOGIN_SESSION_REVOKED_REASONS = Object.freeze([
  'reuse_detected',
  'password_changed',
  'user_disabled',
  'email_changed',
]);

const refreshTokenEntrySchema = new mongoose.Schema(
  {
    // SHA-256 of the opaque refresh token (never the raw value)
    refreshTokenHash: { type: String, required: true },
    // When this refresh token was issued
    issuedAt: { type: Date, required: true },
    // Set when a later refresh consumed this token
    rotatedAt: { type: Date, default: undefined },
  },
  { _id: true },
);

const loginSessionSchema = createBaseSchema({
  // User who signed in
  userId: { type: ObjectId, ref: 'User', required: true },
  // When this sign-in started
  loggedInAt: { type: Date, required: true },
  // Absolute end of this login (24h from first issue; copied across rotations)
  expiresAt: { type: Date, required: true },
  // Refresh-token generations of this login (oldest → newest)
  tokens: { type: [refreshTokenEntrySchema], required: true },
  // User logout only
  loggedOutAt: { type: Date, default: undefined },
  // Reuse, password/email change, or account disabled (not logout)
  revokedAt: { type: Date, default: undefined },
  revokedReason: {
    type: String,
    enum: LOGIN_SESSION_REVOKED_REASONS,
    default: undefined,
  },
});

loginSessionSchema.index({ 'tokens.refreshTokenHash': 1 }, { unique: true });
loginSessionSchema.index({ orgId: 1, userId: 1, status: 1 });
loginSessionSchema.index({ expiresAt: 1 });
loginSessionSchema.index(
  { _id: 1, status: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const LoginSession =
  mongoose.models.LoginSession ??
  mongoose.model('LoginSession', loginSessionSchema, 'loginsessions');
