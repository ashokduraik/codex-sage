/**
 * User Mongoose model — tenant-scoped; passwordHash excluded by default.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

/** Domain lifecycle for a user (separate from row status). */
export const USER_STATUS_VALUES = Object.freeze(['active', 'invited', 'disabled']);

const userSchema = createBaseSchema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  displayName: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 120,
  },
  passwordHash: {
    type: String,
    select: false,
    default: undefined,
  },
  passwordUpdatedAt: {
    type: Date,
    default: undefined,
  },
  mustChangePassword: {
    type: Boolean,
    required: true,
    default: false,
  },
  userStatus: {
    type: String,
    enum: USER_STATUS_VALUES,
    required: true,
    default: 'invited',
  },
  lastLoginAt: {
    type: Date,
    default: undefined,
  },
});

userSchema.index(
  { orgId: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
userSchema.index({ orgId: 1, status: 1, _id: -1 });
userSchema.index({ orgId: 1, userStatus: 1, _id: -1 });

export const User =
  mongoose.models.User ?? mongoose.model('User', userSchema, 'users');
