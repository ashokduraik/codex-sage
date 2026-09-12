/**
 * Shared helper: bump org aclVersion and drop process-local project ACL cache.
 */
import { bumpOrganizationAclVersion } from '../identity/organization.repository.js';
import { invalidateProjectAclCache } from './projectAclCache.js';

/**
 * Increments organization.aclVersion and invalidates the local project ACL cache.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<void>}
 */
export async function bumpProjectAclVersion(orgId, options = {}) {
  await bumpOrganizationAclVersion(orgId, options);
  invalidateProjectAclCache(String(orgId));
}
