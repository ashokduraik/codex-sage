/**
 * masters/organizations.js — org CRUD/bootstrap plus writable retention policy.
 */
import { z } from 'zod';
import mongoose from 'mongoose';
import { Organization } from '../../models/organization.model.js';
import { ApiError, apiErrorFromCaught, caughtErrorFields } from '../../platform/errors.js';
import { hashPassword, recordAuditEvent, buildAuditContextFromRequest } from '../access/index.js';
import { ADMIN_ROLE_CODE, duplicateKeyField, ensureAdminRole, isDuplicateKeyError } from './roles.js';
import { createUserInRepo, findUserByEmail, findUserByIdWithPassword, setPasswordHashIfMissing, updateUser } from './users.js';

/** Solution §12.3 defaults — single source for schema, API, and cleanup job. */
export const RETENTION_POLICY_DEFAULTS = Object.freeze({
  readySourceVersionsKeep: 3,
  jobDays: 180,
  notificationDays: 90,
  notificationReadDays: 30,
  usageDays: 730,
  conversationDays: 365,
  auditDays: 730,
});

/** Inclusive bounds for admin PATCH (named constants, not env). */
export const RETENTION_POLICY_BOUNDS = Object.freeze({
  readySourceVersionsKeep: Object.freeze({ min: 1, max: 20 }),
  dayFields: Object.freeze({ min: 1, max: 3650 }),
});

/** Field names accepted on GET/PATCH retention policy. */
export const RETENTION_POLICY_FIELD_NAMES = Object.freeze([
  'readySourceVersionsKeep',
  'jobDays',
  'notificationDays',
  'notificationReadDays',
  'usageDays',
  'conversationDays',
  'auditDays',
]);

// --- from identity/organization.repository.js ---
/**
 * Organization repository — slug lookup, create, soft delete (not tenant-scoped by orgId arg).
 */
/**
 * Finds an active organization by slug.
 * @param {string} slug Tenant handle.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findOrganizationBySlug(slug, options = {}) {
  const query = Organization.findOne({ slug: String(slug).toLowerCase().trim() });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Finds an active organization by id.
 * @param {import('mongoose').Types.ObjectId | string} organizationId Organization _id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findOrganizationById(organizationId, options = {}) {
  const query = Organization.findById(organizationId);
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Creates an organization (system/bootstrap stamps null actors).
 * @param {{
 *   code: string,
 *   name: string,
 *   slug: string,
 *   config?: object,
 *   createdBy?: import('mongoose').Types.ObjectId | null,
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 * }} input Organization fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createOrganization(input, options = {}) {
  try {
    const [doc] = await Organization.create(
      [
        {
          code: String(input.code).toUpperCase(),
          name: input.name,
          slug: input.slug,
          config: input.config ?? {},
          createdBy: input.createdBy ?? null,
          updatedBy: input.updatedBy ?? null,
        },
      ],
      options.session ? { session: options.session } : undefined,
    );
    return doc;
  } catch (err) {
    if (isDuplicateKeyError(err) && duplicateKeyField(err) === 'code') {
      throw apiErrorFromCaught('IDENTITY_DUPLICATE_ORG_CODE', err, {
        logLevel: 'warn',
        logMessage: 'organization code conflict',
      });
    }
    throw err;
  }
}

/**
 * Increments organization.aclVersion (project ACL cache invalidation).
 * @param {import('mongoose').Types.ObjectId | string} organizationId Organization _id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<number | null>} Next aclVersion, or null when org missing.
 */
export async function bumpOrganizationAclVersion(organizationId, options = {}) {
  const query = Organization.findOneAndUpdate({ _id: organizationId }, { $inc: { aclVersion: 1 } }, { returnDocument: 'after' });
  if (options.session) {
    query.session(options.session);
  }
  const updated = await query.exec();
  return updated ? updated.aclVersion : null;
}

// --- from identity/bootstrapSeed.js ---
/**
 * Idempotent transactional bootstrap seed — runs on API startup only.
 */
/** Display name of the first organization. */
export const DEFAULT_ORG_NAME = 'Default Organization';

/** Tenant handle (slug) of the first organization. */
export const DEFAULT_ORG_SLUG = 'default';

/** Identity code of the first organization. */
export const DEFAULT_ORG_CODE = 'DEFAULT_ORG';

/** Identity code of the bootstrap administrator user. */
export const DEFAULT_ADMIN_USER_CODE = 'ADMIN';

/** First administrator email (stored lowercase). */
export const DEFAULT_ADMIN_EMAIL = 'admin@localhost';

/** First administrator display name. */
export const DEFAULT_ADMIN_NAME = 'Administrator';

/**
 * Default plaintext password for the bootstrap administrator (local/MVP).
 * Hashed at seed; change after first login (Phase 08). Never log this value.
 */
export const DEFAULT_ADMIN_PASSWORD = 'abc123';

/**
 * @typedef {object} BootstrapSeedResult
 * @property {'created' | 'already_present'} result
 * @property {string} orgId
 * @property {string} slug
 * @property {string} adminUserId
 * @property {string} adminUserStatus
 * @property {string} [adminRoleCode]
 */

/**
 * @typedef {object} SeedLogger
 * @property {(obj: object, msg: string) => void} info
 * @property {(obj: object, msg: string) => void} [debug]
 * @property {(obj: object, msg: string) => void} [error]
 */

/**
 * Ensures the default organization, ADMIN role, and admin user exist.
 * @param {SeedLogger} log Structured logger (info always; debug per step).
 * @returns {Promise<BootstrapSeedResult>}
 * @throws {ApiError} BOOTSTRAP_FAILED when the seed cannot complete.
 */
export async function runBootstrapSeed(log) {
  const session = await mongoose.startSession();
  let insertedAny = false;
  /** @type {BootstrapSeedResult | null} */
  let summary = null;

  try {
    await session.withTransaction(async () => {
      const debug = typeof log.debug === 'function' ? log.debug.bind(log) : () => {};

      let organization = await findOrganizationBySlug(DEFAULT_ORG_SLUG, { session });
      if (!organization) {
        try {
          organization = await createOrganization(
            {
              code: DEFAULT_ORG_CODE,
              name: DEFAULT_ORG_NAME,
              slug: DEFAULT_ORG_SLUG,
              createdBy: null,
              updatedBy: null,
            },
            { session },
          );
          insertedAny = true;
          debug({ step: 'organization', outcome: 'created' }, 'bootstrap seed step');
        } catch (err) {
          if (!isDuplicateKeyError(err)) {
            throw err;
          }
          organization = await findOrganizationBySlug(DEFAULT_ORG_SLUG, { session });
          debug({ step: 'organization', outcome: 'already_present' }, 'bootstrap seed step');
        }
      } else {
        debug({ step: 'organization', outcome: 'already_present' }, 'bootstrap seed step');
      }

      if (!organization) {
        throw ApiError.fromCode('BOOTSTRAP_FAILED', {
          message: 'Organization could not be ensured.',
        });
      }

      const orgId = organization._id;
      const { role: adminRole, created: adminRoleCreated } = await ensureAdminRole(orgId, {
        session,
        onStep: ({ code, created }) => {
          debug({ step: 'role', code, outcome: created ? 'created' : 'already_present' }, 'bootstrap seed step');
        },
      });
      if (adminRoleCreated) {
        insertedAny = true;
      }

      let adminUser = await findUserByEmail(orgId, DEFAULT_ADMIN_EMAIL, { session });
      if (!adminUser) {
        if (!adminRole) {
          throw ApiError.fromCode('BOOTSTRAP_FAILED', {
            message: 'ADMIN role missing; cannot create the bootstrap administrator.',
          });
        }
        try {
          adminUser = await createUserInRepo(
            orgId,
            {
              code: DEFAULT_ADMIN_USER_CODE,
              email: DEFAULT_ADMIN_EMAIL,
              displayName: DEFAULT_ADMIN_NAME,
              userStatus: 'invited',
              roleIds: [adminRole._id],
              projectAccessMode: 'all',
              createdBy: null,
              updatedBy: null,
            },
            { session },
          );
          insertedAny = true;
          debug({ step: 'admin_user', outcome: 'created' }, 'bootstrap seed step');
        } catch (err) {
          if (!isDuplicateKeyError(err)) {
            throw err;
          }
          adminUser = await findUserByEmail(orgId, DEFAULT_ADMIN_EMAIL, { session });
          debug({ step: 'admin_user', outcome: 'already_present' }, 'bootstrap seed step');
        }
      } else {
        /** @type {Record<string, unknown>} */
        const adminPatch = {};
        if ((!adminUser.roleIds || adminUser.roleIds.length === 0) && adminRole) {
          adminPatch.roleIds = [adminRole._id];
        }
        if (adminUser.projectAccessMode !== 'all') {
          adminPatch.projectAccessMode = 'all';
        }
        if (Object.keys(adminPatch).length > 0) {
          adminUser = await updateUser(
            orgId,
            adminUser._id,
            {
              ...adminPatch,
              updatedBy: null,
            },
            { session },
          );
          insertedAny = true;
          debug({ step: 'admin_user', outcome: 'roles_and_project_access_ensured' }, 'bootstrap seed step');
        } else {
          debug({ step: 'admin_user', outcome: 'already_present' }, 'bootstrap seed step');
        }
      }

      if (!adminUser) {
        throw ApiError.fromCode('BOOTSTRAP_FAILED', {
          message: 'Administrator user could not be ensured.',
        });
      }

      summary = {
        result: insertedAny ? 'created' : 'already_present',
        orgId: String(orgId),
        slug: organization.slug,
        adminUserId: String(adminUser._id),
        adminUserStatus: adminUser.userStatus,
        adminRoleCode: adminRole ? ADMIN_ROLE_CODE : undefined,
      };
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'BOOTSTRAP_FAILED') {
      log.error?.({ code: err.code, ...caughtErrorFields(err) }, err.message);
      throw err;
    }
    throw apiErrorFromCaught('BOOTSTRAP_FAILED', err, {
      message: 'Bootstrap seed failed.',
      log,
      logMessage: 'Bootstrap seed failed.',
      fields: { code: 'BOOTSTRAP_FAILED' },
    });
  } finally {
    await session.endSession();
  }

  if (!summary) {
    throw ApiError.fromCode('BOOTSTRAP_FAILED');
  }

  // Password hashing stays outside the Mongo transaction (CPU-bound; keep locks short).
  const debug = typeof log.debug === 'function' ? log.debug.bind(log) : () => {};
  const adminWithSecret = await findUserByIdWithPassword(summary.orgId, summary.adminUserId);
  if (adminWithSecret && !adminWithSecret.passwordHash) {
    const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
    const updated = await setPasswordHashIfMissing(summary.orgId, summary.adminUserId, passwordHash);
    if (updated.modifiedCount > 0) {
      summary = {
        ...summary,
        result: 'created',
        adminUserStatus: 'active',
      };
      debug({ step: 'admin_password', outcome: 'created' }, 'bootstrap seed step');
    }
  } else if (adminWithSecret) {
    summary = {
      ...summary,
      adminUserStatus: adminWithSecret.userStatus,
    };
    debug({ step: 'admin_password', outcome: 'already_present' }, 'bootstrap seed step');
  }

  log.info(
    {
      result: summary.result,
      orgId: summary.orgId,
      slug: summary.slug,
      adminUserId: summary.adminUserId,
      adminUserStatus: summary.adminUserStatus,
      adminRoleCode: summary.adminRoleCode,
    },
    'bootstrap seed succeeded',
  );

  return summary;
}

/**
 * Merges a stored or partial policy with §12.3 defaults (existing orgs may lack the subdoc).
 * @param {unknown} stored Raw org.retentionPolicy or null.
 * @returns {{
 *   readySourceVersionsKeep: number,
 *   jobDays: number,
 *   notificationDays: number,
 *   notificationReadDays: number,
 *   usageDays: number,
 *   conversationDays: number,
 *   auditDays: number,
 * }}
 */
export function resolveEffectiveRetentionPolicy(stored) {
  const raw = stored && typeof stored === 'object' ? /** @type {Record<string, unknown>} */ (stored) : {};
  /** @type {Record<string, number>} */
  const effective = { ...RETENTION_POLICY_DEFAULTS };
  for (const fieldName of RETENTION_POLICY_FIELD_NAMES) {
    const value = raw[fieldName];
    if (typeof value === 'number' && Number.isFinite(value)) {
      effective[fieldName] = value;
    }
  }
  return /** @type {typeof RETENTION_POLICY_DEFAULTS} */ (effective);
}

/**
 * Loads the effective retention policy for an organization.
 * @param {string} orgId Tenant id (organization _id).
 * @returns {Promise<ReturnType<typeof resolveEffectiveRetentionPolicy>>}
 * @throws {ApiError} NOT_FOUND when the org is missing.
 */
export async function getRetentionPolicy(orgId) {
  const organization = await findOrganizationById(orgId);
  if (!organization) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Organization not found.' });
  }
  return resolveEffectiveRetentionPolicy(organization.retentionPolicy);
}

/**
 * Validates and persists a retention policy patch, then audits the change.
 * @param {{
 *   orgId: string,
 *   actorUserId: string,
 *   patch: Record<string, number>,
 *   correlationId: string,
 *   ip?: string,
 *   userAgent?: string,
 *   log?: { error?: Function },
 * }} input Update inputs.
 * @returns {Promise<ReturnType<typeof resolveEffectiveRetentionPolicy>>}
 * @throws {ApiError} NOT_FOUND | VALIDATION_ERROR
 */
export async function updateRetentionPolicy(input) {
  const organization = await findOrganizationById(input.orgId);
  if (!organization) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Organization not found.' });
  }
  const previous = resolveEffectiveRetentionPolicy(organization.retentionPolicy);
  const next = { ...previous, ...input.patch };
  assertRetentionPolicyWithinBounds(next);

  const updated = await Organization.findOneAndUpdate(
    { _id: input.orgId },
    {
      $set: {
        retentionPolicy: next,
        updatedBy: input.actorUserId,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  ).exec();
  if (!updated) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Organization not found.' });
  }

  const effective = resolveEffectiveRetentionPolicy(updated.retentionPolicy);
  await recordAuditEvent(
    {
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: 'retention.policy_changed',
      resourceType: 'organization',
      resourceId: String(input.orgId),
      result: 'success',
      correlationId: input.correlationId,
      ip: input.ip,
      userAgent: input.userAgent,
      // Scalars only — audit sanitizer drops nested objects
      context: flattenRetentionPolicyForAudit(previous, effective),
    },
    { log: input.log },
  );
  return effective;
}

/**
 * Flattens before/after retention windows into audit-safe scalar context keys.
 * @param {ReturnType<typeof resolveEffectiveRetentionPolicy>} previous Prior policy.
 * @param {ReturnType<typeof resolveEffectiveRetentionPolicy>} next New policy.
 * @returns {Record<string, number>}
 */
function flattenRetentionPolicyForAudit(previous, next) {
  /** @type {Record<string, number>} */
  const context = {};
  for (const fieldName of RETENTION_POLICY_FIELD_NAMES) {
    context[`previous_${fieldName}`] = previous[fieldName];
    context[`next_${fieldName}`] = next[fieldName];
  }
  return context;
}

/**
 * Throws when any policy field is outside safe min/max.
 * @param {Record<string, number>} policy Candidate policy.
 * @throws {ApiError} VALIDATION_ERROR
 */
function assertRetentionPolicyWithinBounds(policy) {
  /** @type {{ path: string, message: string }[]} */
  const details = [];
  const keep = policy.readySourceVersionsKeep;
  if (
    !Number.isInteger(keep) ||
    keep < RETENTION_POLICY_BOUNDS.readySourceVersionsKeep.min ||
    keep > RETENTION_POLICY_BOUNDS.readySourceVersionsKeep.max
  ) {
    details.push({
      path: 'readySourceVersionsKeep',
      message: `must be an integer between ${RETENTION_POLICY_BOUNDS.readySourceVersionsKeep.min} and ${RETENTION_POLICY_BOUNDS.readySourceVersionsKeep.max}`,
    });
  }
  for (const fieldName of RETENTION_POLICY_FIELD_NAMES) {
    if (fieldName === 'readySourceVersionsKeep') {
      continue;
    }
    const value = policy[fieldName];
    if (!Number.isInteger(value) || value < RETENTION_POLICY_BOUNDS.dayFields.min || value > RETENTION_POLICY_BOUNDS.dayFields.max) {
      details.push({
        path: fieldName,
        message: `must be an integer between ${RETENTION_POLICY_BOUNDS.dayFields.min} and ${RETENTION_POLICY_BOUNDS.dayFields.max}`,
      });
    }
  }
  if (details.length > 0) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details });
  }
}

const retentionPolicyPatchSchema = z
  .object({
    readySourceVersionsKeep: z.number().int().optional(),
    jobDays: z.number().int().optional(),
    notificationDays: z.number().int().optional(),
    notificationReadDays: z.number().int().optional(),
    usageDays: z.number().int().optional(),
    conversationDays: z.number().int().optional(),
    auditDays: z.number().int().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });

/**
 * Maps zod issues to VALIDATION_ERROR details.
 * @param {import('zod').ZodError} error Zod error.
 * @returns {{ path: string, message: string }[]}
 */
function retentionZodDetails(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || 'body',
    message: issue.message,
  }));
}

/**
 * GET /masters/organizations/getRetentionPolicy — effective org retention windows.
 * @param {import('fastify').FastifyRequest} request Request.
 * @returns {Promise<object>}
 */
export async function getRetentionPolicyHttp(request) {
  const orgId = /** @type {string} */ (request.principal.orgId);
  return getRetentionPolicy(orgId);
}

/**
 * PATCH /masters/organizations/updateRetentionPolicy — admin override of retention windows.
 * @param {import('fastify').FastifyRequest} request Request.
 * @returns {Promise<object>}
 */
export async function updateRetentionPolicyHttp(request) {
  const parsed = retentionPolicyPatchSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    throw ApiError.fromCode('VALIDATION_ERROR', { details: retentionZodDetails(parsed.error) });
  }
  const audit = buildAuditContextFromRequest(request);
  return updateRetentionPolicy({
    orgId: /** @type {string} */ (request.principal.orgId),
    actorUserId: /** @type {string} */ (request.principal.userId),
    patch: parsed.data,
    correlationId: audit.correlationId,
    ip: audit.ip,
    userAgent: audit.userAgent,
    log: request.log,
  });
}
