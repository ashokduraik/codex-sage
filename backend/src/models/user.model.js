/**
 * `users` — people who can sign in to an organization. Holds identity,
 * password hash (hidden by default), and account lifecycle.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

/** Domain lifecycle for a user (separate from row status). */
export const USER_STATUS_VALUES = Object.freeze(['active', 'invited', 'disabled']);

const userSchema = createBaseSchema({
  // Login identity; unique per organization among active users
  email: { type: String, required: true, lowercase: true, trim: true },
  // Name shown in the product UI
  displayName: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  // Argon2 hash of the password; omitted from queries unless explicitly selected
  passwordHash: { type: String, select: false, default: undefined },
  // When the password last changed, used to revoke older sessions
  passwordUpdatedAt: { type: Date, default: undefined },
  // Forces a password reset on next successful login
  mustChangePassword: { type: Boolean, required: true, default: false },
  // Account lifecycle: invited, active, or disabled
  userStatus: { type: String, enum: USER_STATUS_VALUES, required: true, default: 'invited' },
  // Last successful authentication time
  lastLoginAt: { type: Date, default: undefined },
});

userSchema.index(
  { orgId: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
userSchema.index({ orgId: 1, status: 1, createdAt: -1, _id: -1 });
userSchema.index({ orgId: 1, displayName: 1 });
userSchema.index({ orgId: 1, status: 1, _id: -1 });
userSchema.index({ orgId: 1, userStatus: 1, _id: -1 });

export const User =
  mongoose.models.User ?? mongoose.model('User', userSchema, 'users');
