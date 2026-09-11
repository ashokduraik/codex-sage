/**
 * Membership Mongoose model — links a user to an organization with roleIds.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

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
});

membershipSchema.index(
  { orgId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
membershipSchema.index({ orgId: 1, roleIds: 1 });

export const Membership =
  mongoose.models.Membership ??
  mongoose.model('Membership', membershipSchema, 'memberships');
