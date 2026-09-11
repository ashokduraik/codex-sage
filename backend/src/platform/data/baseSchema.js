/**
 * Shared Mongoose base schema: row status, UTC timestamps, actors, optional tenant orgId.
 */
import mongoose from 'mongoose';
import { ApiError } from '../errors.js';
import {
  ROW_STATUS_ACTIVE,
  ROW_STATUS_DELETED,
  ROW_STATUS_VALUES,
} from './rowStatus.js';

const { Schema } = mongoose;

/** Query option that opts out of the default active-only filter. */
export const INCLUDE_DELETED_OPTION = 'includeDeleted';

/**
 * Marks a query so soft-deleted rows (`status: 'D'`) are visible.
 * @param {import('mongoose').Query} query Mongoose query instance.
 * @returns {import('mongoose').Query} The same query for chaining.
 */
export function includeDeleted(query) {
  query.setOptions({ [INCLUDE_DELETED_OPTION]: true });
  return query;
}

/**
 * Soft-deletes matching active rows (never hard-deletes).
 * @param {import('mongoose').Model} model Target model.
 * @param {object} filter Match filter (caller supplies tenant keys).
 * @param {{
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 *   session?: import('mongoose').ClientSession,
 * }} [options] Actor stamp and optional Mongo session.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDelete(model, filter, options = {}) {
  const updatedBy = options.updatedBy === undefined ? null : options.updatedBy;
  const query = model.updateOne(
    { ...filter, status: ROW_STATUS_ACTIVE },
    {
      $set: {
        status: ROW_STATUS_DELETED,
        updatedBy,
        updatedAt: new Date(),
      },
    },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Throws when a tenant-scoped repository call omits orgId.
 * @param {unknown} orgId Candidate organization id.
 * @throws {ApiError} TENANT_SCOPE_MISSING
 */
export function assertOrgId(orgId) {
  if (orgId === undefined || orgId === null || orgId === '') {
    throw ApiError.fromCode('TENANT_SCOPE_MISSING');
  }
}

/**
 * Applies default active-row filter unless status is explicit or includeDeleted is set.
 * @param {import('mongoose').Schema} schema Target schema.
 */
function applySoftDeleteQueryDefaults(schema) {
  const filterActiveUnlessOptedIn = function filterActiveUnlessOptedIn() {
    if (this.getOptions()?.[INCLUDE_DELETED_OPTION]) {
      return;
    }
    const conditions = this.getQuery();
    if (Object.prototype.hasOwnProperty.call(conditions, 'status')) {
      return;
    }
    this.where({ status: ROW_STATUS_ACTIVE });
  };

  schema.pre('find', filterActiveUnlessOptedIn);
  schema.pre('findOne', filterActiveUnlessOptedIn);
  schema.pre('countDocuments', filterActiveUnlessOptedIn);
  schema.pre('findOneAndUpdate', filterActiveUnlessOptedIn);
}

/**
 * Requires orgId on validate for tenant-scoped schemas.
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
 * Builds a domain schema with base fields and shared plugins.
 * @param {import('mongoose').SchemaDefinition} definition Domain fields (not base fields).
 * @param {{
 *   tenantScoped?: boolean,
 *   schemaOptions?: import('mongoose').SchemaOptions,
 * }} [options] When `tenantScoped` is false, orgId is omitted (e.g. organizations).
 * @returns {import('mongoose').Schema}
 */
export function createBaseSchema(definition, options = {}) {
  const tenantScoped = options.tenantScoped !== false;
  const schemaOptions = options.schemaOptions ?? {};

  /** @type {import('mongoose').SchemaDefinition} */
  const fields = {
    ...definition,
    status: {
      type: String,
      enum: ROW_STATUS_VALUES,
      required: true,
      default: ROW_STATUS_ACTIVE,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      default: null,
    },
  };

  if (tenantScoped) {
    fields.orgId = {
      type: Schema.Types.ObjectId,
      required: true,
    };
  }

  const schema = new Schema(fields, {
    timestamps: {
      createdAt: true,
      updatedAt: true,
    },
    ...schemaOptions,
  });

  applySoftDeleteQueryDefaults(schema);
  if (tenantScoped) {
    applyTenantOrgIdPlugin(schema);
  }

  return schema;
}

export { ROW_STATUS_ACTIVE, ROW_STATUS_DELETED, ROW_STATUS_VALUES };
