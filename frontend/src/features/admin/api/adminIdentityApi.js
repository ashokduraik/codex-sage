/**
 * Admin identity HTTP calls over the shared API client (Phase 15).
 */
import { apiRequest } from '@/shared/api';

/** Max page size accepted by the identity list endpoints. */
export const ADMIN_IDENTITY_LIST_LIMIT_MAX = 100;

/**
 * Builds a query string from defined filter values.
 * @param {Record<string, string | number | undefined | null>} params Query map.
 * @returns {string} Path suffix starting with `?`, or empty string.
 */
function toQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * Lists organization users with keyset pagination and filters.
 * @param {{
 *   q?: string,
 *   userStatus?: string,
 *   roleId?: string,
 *   cursor?: string,
 *   limit?: number,
 *   signal?: AbortSignal,
 * }} [options] List options.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listUsers(options = {}) {
  const { signal, ...filters } = options;
  const query = toQueryString({
    q: filters.q,
    userStatus: filters.userStatus,
    roleId: filters.roleId,
    cursor: filters.cursor,
    limit: filters.limit,
  });
  return apiRequest(`/users${query}`, { signal });
}

/**
 * Creates an invited user with one or more roles.
 * @param {{
 *   email: string,
 *   displayName: string,
 *   roleIds: string[],
 *   idempotencyKey: string,
 * }} input Create payload.
 * @returns {Promise<object>} Created user DTO.
 */
export async function createUser(input) {
  return apiRequest('/users', {
    method: 'POST',
    body: {
      email: input.email,
      displayName: input.displayName,
      roleIds: input.roleIds,
    },
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Patches mutable user fields (including roleIds).
 * @param {string} userId Target user id.
 * @param {{
 *   email?: string,
 *   displayName?: string,
 *   roleIds?: string[],
 * }} patch Fields to update.
 * @returns {Promise<object>} Updated user DTO.
 */
export async function patchUser(userId, patch) {
  return apiRequest(`/users/${userId}`, {
    method: 'PATCH',
    body: patch,
  });
}

/**
 * Activates a disabled or invited user.
 * @param {string} userId Target user id.
 * @returns {Promise<object>} Updated user DTO.
 */
export async function activateUser(userId) {
  return apiRequest(`/users/${userId}/activate`, { method: 'POST' });
}

/**
 * Deactivates an active user.
 * @param {string} userId Target user id.
 * @returns {Promise<object>} Updated user DTO.
 */
export async function deactivateUser(userId) {
  return apiRequest(`/users/${userId}/deactivate`, { method: 'POST' });
}

/**
 * Soft-removes a user (status D server-side).
 * @param {string} userId Target user id.
 * @returns {Promise<object | undefined>}
 */
export async function removeUser(userId) {
  return apiRequest(`/users/${userId}`, { method: 'DELETE' });
}

/**
 * Administrator sets a new password for another user (secret never returned).
 * @param {string} userId Target user id.
 * @param {{ newPassword: string, idempotencyKey: string }} input Password + idempotency key.
 * @returns {Promise<{ passwordResetStatus: string, completedAt?: string }>}
 */
export async function resetUserPassword(userId, input) {
  return apiRequest(`/users/${userId}/reset-password`, {
    method: 'POST',
    body: { newPassword: input.newPassword },
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Lists one page of organization roles.
 * @param {{ cursor?: string, limit?: number, signal?: AbortSignal }} [options] Page options.
 * @returns {Promise<{ items: object[], pageInfo: { nextCursor: string | null, hasMore: boolean } }>}
 */
export async function listRolesPage(options = {}) {
  const { signal, cursor, limit } = options;
  const query = toQueryString({ cursor, limit });
  return apiRequest(`/roles${query}`, { signal });
}

/**
 * Loads every active role by following keyset pages (MVP org sizes).
 * @param {{ signal?: AbortSignal, limit?: number }} [options] Fetch options.
 * @returns {Promise<object[]>}
 */
export async function listAllRoles(options = {}) {
  const limit = options.limit ?? ADMIN_IDENTITY_LIST_LIMIT_MAX;
  /** @type {object[]} */
  const items = [];
  /** @type {string | undefined} */
  let cursor;
  for (;;) {
    const page = await listRolesPage({
      cursor,
      limit,
      signal: options.signal,
    });
    items.push(...(page.items ?? []));
    if (!page.pageInfo?.hasMore || !page.pageInfo?.nextCursor) {
      break;
    }
    cursor = page.pageInfo.nextCursor;
  }
  return items;
}

/**
 * Loads the human-readable permission catalog.
 * @param {{ signal?: AbortSignal }} [options] Fetch options.
 * @returns {Promise<{ groups: Array<{ id: string, label: string, permissions: object[] }> }>}
 */
export async function fetchPermissionsCatalog(options = {}) {
  return apiRequest('/permissions', { signal: options.signal });
}
