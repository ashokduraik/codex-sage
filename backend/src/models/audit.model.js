/**
 * `auditevents` — one row per security-sensitive action (create user,
 * change email, archive project, denied permission). Used later to
 * answer "who did this, to which object, and did it succeed?"
 *
 * Rows are history: they cannot be edited or hard-deleted. A retention
 * job may only hide old rows by setting status to D.
 */
import mongoose from 'mongoose';
import { ApiError } from '../platform/errors.js';
import { INCLUDE_DELETED_OPTION, ROW_STATUS_ACTIVE, ROW_STATUS_DELETED, ROW_STATUS_VALUES } from '../platform/data/index.js';

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/** Allowed audit result values. */
export const AUDIT_RESULT_VALUES = Object.freeze(['success', 'denied', 'failed']);

/**
 * Applies default active-row filter unless status is explicit or includeDeleted is set.
 * @param {import('mongoose').Schema} schema Target schema.
 */
function applySoftDeleteQueryDefaults(schema) {
  /**
   * @this {import('mongoose').Query}
   */
  function filterActiveUnlessOptedIn() {
    if (this.getOptions()?.[INCLUDE_DELETED_OPTION]) {
      return;
    }
    const conditions = this.getQuery();
    if (Object.prototype.hasOwnProperty.call(conditions, 'status')) {
      return;
    }
    this.where({ status: ROW_STATUS_ACTIVE });
  }

  schema.pre('find', filterActiveUnlessOptedIn);
  schema.pre('findOne', filterActiveUnlessOptedIn);
  schema.pre('countDocuments', filterActiveUnlessOptedIn);
  schema.pre('findOneAndUpdate', filterActiveUnlessOptedIn);
}

/**
 * Requires orgId on validate for tenant-scoped audit rows.
 * @param {import('mongoose').Schema} schema Target schema.
 */
function applyTenantOrgIdPlugin(schema) {
  schema.pre('validate', function rejectMissingOrgId() {
    if (this.orgId === undefined || this.orgId === null) {
      throw ApiError.fromCode('TENANT_SCOPE_MISSING');
    }
  });
}

/**
 * Returns whether an update payload only soft-deletes via status 'D'.
 * @param {object | null | undefined} update Mongoose update document.
 * @returns {boolean}
 */
function isRetentionSoftDeleteOnly(update) {
  if (!update || typeof update !== 'object') {
    return false;
  }
  const set = update.$set ?? {};
  const topLevelKeys = Object.keys(update).filter((key) => !key.startsWith('$'));
  const setKeys = Object.keys(set);
  if (topLevelKeys.length > 0) {
    return false;
  }
  const allowedOps = new Set(['$set']);
  for (const key of Object.keys(update)) {
    if (key.startsWith('$') && !allowedOps.has(key)) {
      return false;
    }
  }
  if (setKeys.length !== 1 || setKeys[0] !== 'status') {
    return false;
  }
  return set.status === ROW_STATUS_DELETED;
}

/**
 * Throws when a mutation is not an authorized retention soft-delete.
 * @param {import('mongoose').Query} query Active query.
 * @param {'update' | 'delete'} kind Mutation kind.
 */
function assertAppendOnly(query, kind) {
  const options = query.getOptions?.() ?? {};
  if (options.retentionJob === true) {
    if (kind === 'delete') {
      throw new Error('AuditEvent retention may only soft-delete (status D), not hard-delete');
    }
    if (!isRetentionSoftDeleteOnly(query.getUpdate?.())) {
      throw new Error('AuditEvent retentionJob may only set status to D');
    }
    return;
  }
  throw new Error('AuditEvent is append-only; updates and deletes require retentionJob');
}

const auditEventSchema = new Schema(
  {
    // Organization this history belongs to (Acme)
    orgId: { type: ObjectId, ref: 'Organization', required: true },
    // Signed-in user who performed the action (the actor, not the target)
    actorUserId: { type: ObjectId, ref: 'User', default: undefined },
    // What happened: user.email_changed, project.archive, authz.denied
    action: { type: String, required: true, trim: true },
    // What was acted on: user, project, route, etc. (not the URL)
    resourceType: { type: String, required: true, trim: true },
    // Which one: Alice's user id, a project id, or a route label
    resourceId: { type: String, default: undefined },
    // Whether the action succeeded, was denied, or failed
    result: { type: String, enum: AUDIT_RESULT_VALUES, required: true },
    // Same as request.id / X-Correlation-Id; joins this row to logs for one HTTP call
    correlationId: { type: String, required: true, trim: true },
    // Client IP of the request, for security review
    ip: { type: String, default: undefined },
    // Browser / client string of the request, for security review
    userAgent: { type: String, default: undefined },
    // Extra non-secret details (old/new email). Secrets are stripped before save
    context: { type: Schema.Types.Mixed, default: undefined },
    // A = visible history; D = hidden by retention (not a user delete)
    status: { type: String, enum: ROW_STATUS_VALUES, required: true, default: ROW_STATUS_ACTIVE },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

auditEventSchema.index({ orgId: 1, status: 1, createdAt: -1, _id: -1 });
auditEventSchema.index({ orgId: 1, actorUserId: 1, createdAt: -1 });
auditEventSchema.index({ orgId: 1, action: 1, createdAt: -1 });
auditEventSchema.index({ orgId: 1, resourceType: 1, resourceId: 1, createdAt: -1 });

applySoftDeleteQueryDefaults(auditEventSchema);
applyTenantOrgIdPlugin(auditEventSchema);

auditEventSchema.pre('updateOne', function guardUpdateOne() {
  assertAppendOnly(this, 'update');
});
auditEventSchema.pre('updateMany', function guardUpdateMany() {
  assertAppendOnly(this, 'update');
});
auditEventSchema.pre('findOneAndUpdate', function guardFindOneAndUpdate() {
  assertAppendOnly(this, 'update');
});
auditEventSchema.pre('deleteOne', function guardDeleteOne() {
  assertAppendOnly(this, 'delete');
});
auditEventSchema.pre('deleteMany', function guardDeleteMany() {
  assertAppendOnly(this, 'delete');
});
auditEventSchema.pre('findOneAndDelete', function guardFindOneAndDelete() {
  assertAppendOnly(this, 'delete');
});

export const AuditEvent = mongoose.models.AuditEvent ?? mongoose.model('AuditEvent', auditEventSchema, 'auditevents');
