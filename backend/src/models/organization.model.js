/**
 * Organization Mongoose model — opts out of the tenant orgId plugin.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

/** Lowercase slug pattern for tenant handles. */
export const SLUG_PATTERN = /^[a-z0-9-]{2,64}$/;

const organizationSchema = createBaseSchema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      validate: {
        /**
         * @param {string} value Candidate slug.
         * @returns {boolean}
         */
        validator(value) {
          return typeof value === 'string' && SLUG_PATTERN.test(value);
        },
        message: 'slug must match [a-z0-9-]{2,64}',
      },
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    /** Bumped when RBAC / project ACL inputs change; project ACL cache keys on this. */
    aclVersion: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  { tenantScoped: false },
);

organizationSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
organizationSchema.index({ status: 1, _id: -1 });

export const Organization =
  mongoose.models.Organization ??
  mongoose.model('Organization', organizationSchema, 'organizations');
