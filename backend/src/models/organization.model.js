/**
 * `organizations` — one company account (Acme). Every other collection
 * stores this row's `_id` as `orgId`, so Acme data never mixes with
 * another company.
 *
 * This collection has no `orgId` column: the row `_id` *is* the tenant id.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

/** Allowed org slug: 2–64 lowercase letters, digits, or hyphens. */
export const SLUG_PATTERN = /^[a-z0-9-]{2,64}$/;

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

/** Org retention windows (solution §12.3); worker reads these instead of hard-coded constants only. */
const retentionPolicySchema = new mongoose.Schema(
  {
    // Ready knowledge/source versions to keep per project (older ones soft-deleted)
    readySourceVersionsKeep: { type: Number, required: true, default: 3, min: 1, max: 20 },
    // Soft-delete terminal jobs older than this many days
    jobDays: { type: Number, required: true, default: 180, min: 1, max: 3650 },
    // Soft-delete unread notifications older than this many days
    notificationDays: { type: Number, required: true, default: 90, min: 1, max: 3650 },
    // Soft-delete read notifications this many days after readAt
    notificationReadDays: { type: Number, required: true, default: 30, min: 1, max: 3650 },
    // Soft-delete projectActivities older than this many days (by occurredAt)
    usageDays: { type: Number, required: true, default: 730, min: 1, max: 3650 },
    // Soft-delete archived conversations older than this many days
    conversationDays: { type: Number, required: true, default: 365, min: 1, max: 3650 },
    // Soft-delete audit rows older than this many days (retention job only)
    auditDays: { type: Number, required: true, default: 730, min: 1, max: 3650 },
  },
  { _id: false },
);

const organizationSchema = createBaseSchema(
  {
    // Stable unique handle across orgs, e.g. "DEFAULT_ORG". Set on create only
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
    // Name shown in the UI, e.g. "Acme"
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
    // Unique URL handle, e.g. "acme" (lowercase letters, digits, hyphens)
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
    // Extra org settings that do not need their own column
    config: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // Goes up when roles or project access change, so cached permissions are discarded
    aclVersion: { type: Number, required: true, default: 0, min: 0 },
    // How long the retention worker keeps aged org data (admins may PATCH)
    retentionPolicy: { type: retentionPolicySchema, required: true, default: () => ({}) },
  },
  { tenantScoped: false },
);

organizationSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
organizationSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
organizationSchema.index({ status: 1, _id: -1 });

export const Organization = mongoose.models.Organization ?? mongoose.model('Organization', organizationSchema, 'organizations');
