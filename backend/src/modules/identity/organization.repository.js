/**
 * Organization repository — slug lookup, create, soft delete (not tenant-scoped by orgId arg).
 */
import { softDelete } from '../../platform/data/index.js';
import { Organization } from './organization.model.js';

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
  const [doc] = await Organization.create(
    [
      {
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
}

/**
 * Soft-deletes an active organization.
 * @param {import('mongoose').Types.ObjectId | string} organizationId Organization _id.
 * @param {{ updatedBy?: import('mongoose').Types.ObjectId | null }} [options] Actor stamp.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteOrganization(organizationId, options = {}) {
  return softDelete(
    Organization,
    { _id: organizationId },
    { updatedBy: options.updatedBy ?? null },
  );
}

/**
 * Increments organization.aclVersion (project ACL cache invalidation).
 * @param {import('mongoose').Types.ObjectId | string} organizationId Organization _id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<number | null>} Next aclVersion, or null when org missing.
 */
export async function bumpOrganizationAclVersion(organizationId, options = {}) {
  const query = Organization.findOneAndUpdate(
    { _id: organizationId },
    { $inc: { aclVersion: 1 } },
    { returnDocument: 'after' },
  );
  if (options.session) {
    query.session(options.session);
  }
  const updated = await query.exec();
  return updated ? updated.aclVersion : null;
}
