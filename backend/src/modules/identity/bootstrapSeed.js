/**
 * Idempotent transactional bootstrap seed — runs on API startup only.
 */
import mongoose from 'mongoose';
import { ApiError } from '../../platform/errors.js';
import { BUILT_IN_ROLE_KEYS } from './role.model.js';
import {
  createOrganization,
  findOrganizationBySlug,
} from './organization.repository.js';
import {
  createUser,
  findUserByEmail,
  findUserByIdWithPassword,
  setPasswordHashIfMissing,
} from './user.repository.js';
import { ensureBuiltInRoles } from './role.repository.js';
import {
  createMembership,
  findMembership,
} from './membership.repository.js';
import { hashPassword } from '../auth/passwordHasher.js';

/** Display name of the first organization. */
export const DEFAULT_ORG_NAME = 'Default Organization';

/** Tenant handle (slug) of the first organization. */
export const DEFAULT_ORG_SLUG = 'default';

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
 * @property {string[]} builtInRoles
 */

/**
 * @typedef {object} SeedLogger
 * @property {(obj: object, msg: string) => void} info
 * @property {(obj: object, msg: string) => void} [debug]
 * @property {(obj: object, msg: string) => void} [error]
 */

/**
 * Ensures the default organization, built-in roles, admin user, and membership exist.
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
      const { roles, createdCount: rolesCreated } = await ensureBuiltInRoles(orgId, {
        session,
        onStep: ({ key, created }) => {
          debug(
            { step: 'role', builtInKey: key, outcome: created ? 'created' : 'already_present' },
            'bootstrap seed step',
          );
        },
      });
      if (rolesCreated > 0) {
        insertedAny = true;
      }

      const orgAdmin = roles.find((role) => role.builtInKey === 'org_admin');
      if (!orgAdmin) {
        throw ApiError.fromCode('BOOTSTRAP_FAILED', {
          message: 'org_admin role missing after seed.',
        });
      }

      let adminUser = await findUserByEmail(orgId, DEFAULT_ADMIN_EMAIL, { session });
      if (!adminUser) {
        try {
          adminUser = await createUser(
            orgId,
            {
              email: DEFAULT_ADMIN_EMAIL,
              displayName: DEFAULT_ADMIN_NAME,
              userStatus: 'invited',
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
        debug({ step: 'admin_user', outcome: 'already_present' }, 'bootstrap seed step');
      }

      if (!adminUser) {
        throw ApiError.fromCode('BOOTSTRAP_FAILED', {
          message: 'Administrator user could not be ensured.',
        });
      }

      let membership = await findMembership(orgId, adminUser._id, { session });
      if (!membership) {
        try {
          membership = await createMembership(
            orgId,
            {
              userId: adminUser._id,
              roleIds: [orgAdmin._id],
              projectAccessMode: 'all',
              createdBy: null,
              updatedBy: null,
            },
            { session },
          );
          insertedAny = true;
          debug({ step: 'membership', outcome: 'created' }, 'bootstrap seed step');
        } catch (err) {
          if (!isDuplicateKeyError(err)) {
            throw err;
          }
          membership = await findMembership(orgId, adminUser._id, { session });
          debug({ step: 'membership', outcome: 'already_present' }, 'bootstrap seed step');
        }
      } else {
        if (membership.projectAccessMode !== 'all') {
          membership.projectAccessMode = 'all';
          membership.updatedBy = null;
          await membership.save({ session });
          insertedAny = true;
          debug(
            { step: 'membership', outcome: 'project_access_mode_all' },
            'bootstrap seed step',
          );
        } else {
          debug({ step: 'membership', outcome: 'already_present' }, 'bootstrap seed step');
        }
      }

      if (!membership) {
        throw ApiError.fromCode('BOOTSTRAP_FAILED', {
          message: 'Administrator membership could not be ensured.',
        });
      }

      summary = {
        result: insertedAny ? 'created' : 'already_present',
        orgId: String(orgId),
        slug: organization.slug,
        adminUserId: String(adminUser._id),
        adminUserStatus: adminUser.userStatus,
        builtInRoles: [...BUILT_IN_ROLE_KEYS],
      };
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'BOOTSTRAP_FAILED') {
      log.error?.({ code: err.code }, err.message);
      throw err;
    }
    const wrapped = ApiError.fromCode('BOOTSTRAP_FAILED', {
      message: 'Bootstrap seed failed.',
    });
    log.error?.({ code: wrapped.code, errName: err instanceof Error ? err.name : 'Error' }, wrapped.message);
    throw wrapped;
  } finally {
    await session.endSession();
  }

  if (!summary) {
    throw ApiError.fromCode('BOOTSTRAP_FAILED');
  }

  // Password hashing stays outside the Mongo transaction (CPU-bound; keep locks short).
  const debug =
    typeof log.debug === 'function' ? log.debug.bind(log) : () => {};
  const adminWithSecret = await findUserByIdWithPassword(
    summary.orgId,
    summary.adminUserId,
  );
  if (adminWithSecret && !adminWithSecret.passwordHash) {
    const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
    const updated = await setPasswordHashIfMissing(
      summary.orgId,
      summary.adminUserId,
      passwordHash,
    );
    if (updated.modifiedCount > 0) {
      summary = {
        ...summary,
        result: 'created',
        adminUserStatus: 'active',
      };
      debug(
        { step: 'admin_password', outcome: 'created' },
        'bootstrap seed step',
      );
    }
  } else if (adminWithSecret) {
    summary = {
      ...summary,
      adminUserStatus: adminWithSecret.userStatus,
    };
    debug(
      { step: 'admin_password', outcome: 'already_present' },
      'bootstrap seed step',
    );
  }

  log.info(
    {
      result: summary.result,
      orgId: summary.orgId,
      slug: summary.slug,
      adminUserId: summary.adminUserId,
      adminUserStatus: summary.adminUserStatus,
      builtInRoles: summary.builtInRoles,
    },
    'bootstrap seed succeeded',
  );

  return summary;
}

/**
 * @param {unknown} err Driver / Mongoose error.
 * @returns {boolean}
 */
function isDuplicateKeyError(err) {
  return (
    typeof err === 'object' &&
    err !== null &&
    /** @type {{ code?: number }} */ (err).code === 11000
  );
}
