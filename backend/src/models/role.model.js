/**
 * `roles` — a named set of permissions in one organization.
 * Example: "Org Admin" can manage users; a custom "Finance reader" can only read.
 *
 * Seed creates one row with `code: "ADMIN"`. Admins may create any number of
 * additional roles. Permissions live on this document (not a code map).
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

/** Allowed identity code: 2–64 uppercase letters, digits, hyphens, or underscores. */
export const MASTER_CODE_PATTERN = /^[A-Z0-9_-]{2,64}$/;

/**
 * Returns whether `value` is a valid identity code.
 * @param {unknown} value Candidate code.
 * @returns {boolean}
 */
function isValidMasterCode(value) {
  return typeof value === 'string' && MASTER_CODE_PATTERN.test(value);
}

const roleSchema = createBaseSchema({
  // Stable unique handle in the org, e.g. "ADMIN" or "FINANCE-READER". Set on create only
  code: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
    validate: {
      /**
       * @param {string} value Candidate code.
       * @returns {boolean}
       */
      validator: isValidMasterCode,
      message: 'code must match [A-Z0-9_-]{2,64}',
    },
  },
  // Name shown in the UI, unique in the org, e.g. "Org Admin" or "Finance reader"
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  // Optional sentence explaining what this role is for
  description: { type: String, trim: true, default: undefined },
  // Catalog permission keys this role grants, e.g. ["users.manage", "projects.view"]
  permissions: { type: [String], default: () => [] },
});

roleSchema.index({ orgId: 1, name: 1 }, { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
roleSchema.index({ orgId: 1, code: 1 }, { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
roleSchema.index({ orgId: 1, status: 1, createdAt: -1, _id: -1 });

export const Role = mongoose.models.Role ?? mongoose.model('Role', roleSchema, 'roles');
