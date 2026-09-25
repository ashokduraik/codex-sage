/**
 * Membership Mongoose model — links a user to an organization with roleIds.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

/** How org membership maps onto project visibility (backend §8). */
export const PROJECT_ACCESS_MODE_VALUES = Object.freeze(['all', 'selected', 'none']);

const membershipSchema = createBaseSchema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  roleIds: {
    type: [mongoose.Schema.Types.ObjectId],
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
  projectAccessMode: {
    type: String,
    enum: PROJECT_ACCESS_MODE_VALUES,
    required: true,
    default: 'selected',
  },
});

membershipSchema.index(
  { orgId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
membershipSchema.index({ orgId: 1, roleIds: 1 });

export const Membership =
  mongoose.models.Membership ??
  mongoose.model('Membership', membershipSchema, 'memberships');
