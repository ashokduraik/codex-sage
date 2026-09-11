/**
 * Compares an organization path parameter to the authenticated principal's org.
 * Mismatch is indistinguishable from not-found (no cross-tenant existence leak).
 */
import { ApiError } from '../../platform/errors.js';

/**
 * Ensures a path/query org id matches the principal. Never trusts the client value as scope.
 * @param {string | undefined} pathOrgId Client-supplied organization id.
 * @param {{ orgId: string }} principal Authenticated principal.
 * @throws {ApiError} NOT_FOUND when missing or mismatched.
 */
export function assertOrganizationPathMatchesPrincipal(pathOrgId, principal) {
  if (typeof pathOrgId !== 'string' || !pathOrgId) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Resource not found.' });
  }
  if (String(pathOrgId) !== String(principal.orgId)) {
    throw ApiError.fromCode('NOT_FOUND', { message: 'Resource not found.' });
  }
}
