/**
 * Membership repository — tenant-scoped.
 */
import mongoose from 'mongoose';
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
 *   projectAccessMode?: 'all' | 'selected' | 'none',
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
        projectAccessMode: input.projectAccessMode ?? 'selected',
        createdBy: input.createdBy ?? null,
        updatedBy: input.updatedBy ?? null,
      },
    ],
    options.session ? { session: options.session } : undefined,
  );
  return doc;
}

/**
 * Sets projectAccessMode on an active membership.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId Member user id.
 * @param {'all' | 'selected' | 'none'} projectAccessMode Next access mode.
 * @param {{
 *   updatedBy?: import('mongoose').Types.ObjectId | string | null,
 *   session?: import('mongoose').ClientSession,
 * }} [options] Actor and session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function updateMembershipProjectAccessMode(
  orgId,
  userId,
  projectAccessMode,
  options = {},
) {
  assertOrgId(orgId);
  const query = Membership.findOneAndUpdate(
    { orgId, userId },
    {
      $set: {
        projectAccessMode,
        updatedBy: options.updatedBy ?? null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Lists active memberships in an organization.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function listMemberships(orgId, options = {}) {
  assertOrgId(orgId);
  const query = Membership.find({ orgId }).sort({ _id: -1 });
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Replaces the role set on an active membership atomically.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId Member user id.
 * @param {Array<import('mongoose').Types.ObjectId | string>} roleIds Next role ids.
 * @param {{
 *   updatedBy?: import('mongoose').Types.ObjectId | string | null,
 *   session?: import('mongoose').ClientSession,
 * }} [options] Actor and session.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function replaceMembershipRoleIds(orgId, userId, roleIds, options = {}) {
  assertOrgId(orgId);
  const query = Membership.findOneAndUpdate(
    { orgId, userId },
    {
      $set: {
        roleIds,
        updatedBy: options.updatedBy ?? null,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  if (options.session) {
    query.session(options.session);
  }
  return query.exec();
}

/**
 * Returns whether any active membership references the role.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} roleId Role id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<boolean>}
 */
export async function isRoleReferencedByActiveMembership(orgId, roleId, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(roleId)) {
    return false;
  }
  const query = Membership.findOne({ orgId, roleIds: roleId }).select({ _id: 1 });
  if (options.session) {
    query.session(options.session);
  }
  const found = await query.exec();
  return Boolean(found);
}

/**
 * Soft-deletes an active membership.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} userId Member user id.
 * @param {{
 *   updatedBy?: import('mongoose').Types.ObjectId | null,
 *   session?: import('mongoose').ClientSession,
 * }} [options] Actor stamp and session.
 * @returns {Promise<import('mongoose').UpdateResult>}
 */
export async function softDeleteMembership(orgId, userId, options = {}) {
  assertOrgId(orgId);
  return softDelete(
    Membership,
    { orgId, userId },
    { updatedBy: options.updatedBy ?? null, session: options.session },
  );
}
