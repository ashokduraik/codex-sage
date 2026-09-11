/**
 * Membership repository — tenant-scoped.
 */
import { assertOrgId, softDelete } from '../../platform/data/index.js';
import { Membership } from './membership.model.js';

/**
 * Finds an active membership by org and user.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId Member user id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findMembership(orgId, userId, options = {}) {
  assertOrgId(orgId);
  const query = Membership.findOne({ orgId, userId });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Creates a membership.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{
 *   userId: import('mongoose').Types.ObjectId | string,
 *   roleIds: Array<import('mongoose').Types.ObjectId | string>,
 *   createdBy?: import('mongoose').Types.ObjectId | null,
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 * }} input Membership fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function createMembership(orgId, input, options = {}) {
  assertOrgId(orgId);
  const [doc] = await Membership.create(
    [
      {
        orgId,
        userId: input.userId,
        roleIds: input.roleIds,
        createdBy: input.createdBy ?? null,
        updatedBy: input.updatedBy ?? null,
      },
    ],
    options.session ? { session: options.session } : undefined,
  );
  return doc;
}

/**
 * Lists active memberships in an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function listMemberships(orgId) {
  assertOrgId(orgId);
  return Membership.find({ orgId }).sort({ _id: -1 }).exec();
}

/**
 * Soft-deletes an active membership.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId Member user id.
 * @param {{ updatedBy?: import('mongoose').Types.ObjectId | null }} [options] Actor stamp.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteMembership(orgId, userId, options = {}) {
  assertOrgId(orgId);
  return softDelete(
    Membership,
    { orgId, userId },
    { updatedBy: options.updatedBy ?? null },
  );
}
