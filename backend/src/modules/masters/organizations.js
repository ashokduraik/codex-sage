/**
 * masters/organizations.js — merged resource file.
 */
import { Organization } from '../../models/organization.model.js';
import { ApiError, apiErrorFromCaught, caughtErrorFields } from '../../platform/errors.js';
import { hashPassword } from '../access/index.js';
import { ADMIN_ROLE_CODE, duplicateKeyField, ensureAdminRole, isDuplicateKeyError } from './roles.js';
import { createUserInRepo, findUserByEmail, findUserByIdWithPassword, setPasswordHashIfMissing, updateUser } from './users.js';
import mongoose from 'mongoose';

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
