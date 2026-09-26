/**
 * `users` — one person who can sign in to one organization.
 * Alice at Acme is one row: her email, stored password, whether
 * she is allowed to log in, which org roles she holds, and which
 * projects she can see.
 *
 * `userStatus` is the account (invited / active / disabled).
 * `status` A/D is whether the row is visible (soft delete).
 * `projectAccessMode`: all = every project; selected = only projects
 * she is added to; none = no projects.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** invited / active / disabled — not the same as row status A/D. */
export const USER_STATUS_VALUES = Object.freeze(['active', 'invited', 'disabled']);

/** Which projects a member can see: all, selected, or none. */
export const PROJECT_ACCESS_MODE_VALUES = Object.freeze(['all', 'selected', 'none']);

const userSchema = createBaseSchema({
  // Login email; unique per organization among active users
  email: { type: String, required: true, lowercase: true, trim: true },
  // Name shown in the UI, e.g. "Alice"
  displayName: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  // Stored password (never the raw password). Hidden unless a query asks for it
  passwordHash: { type: String, select: false, default: undefined },
  // Last password change. Sessions issued before this time are revoked
  passwordUpdatedAt: { type: Date, default: undefined },
  // If true, Alice must set a new password after the next login
  mustChangePassword: { type: Boolean, required: true, default: false },
  // invited = not signed in yet; active = can sign in; disabled = blocked
  userStatus: { type: String, enum: USER_STATUS_VALUES, required: true, default: 'invited' },
  // Last successful sign-in
  lastLoginAt: { type: Date, default: undefined },
  // Org roles Alice holds (at least one), e.g. Org Admin + Member
  roleIds: {
    type: [ObjectId],
    ref: 'Role',
    required: true,
    validate: {
      /**
       * @param {unknown[]} value Role id list.
       * @returns {boolean}
       */
      validator(value) {
        return Array.isArray(value) && value.length >= 1;
      },
      message: 'roleIds must contain at least one role',
    },
  },
  // Which projects she can see: all, selected (via projects.members), or none
  projectAccessMode: {
    type: String,
    enum: PROJECT_ACCESS_MODE_VALUES,
    required: true,
    default: 'selected',
  },
});

userSchema.index(
  { orgId: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
userSchema.index({ orgId: 1, status: 1, createdAt: -1, _id: -1 });
userSchema.index({ orgId: 1, displayName: 1 });
userSchema.index({ orgId: 1, status: 1, _id: -1 });
userSchema.index({ orgId: 1, userStatus: 1, _id: -1 });
userSchema.index({ orgId: 1, roleIds: 1 });

export const User =
  mongoose.models.User ?? mongoose.model('User', userSchema, 'users');
