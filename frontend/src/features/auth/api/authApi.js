/**
 * Auth HTTP calls and React Query keys (Phase 14).
 */
import {
  apiRequest,
  CSRF_HEADER_NAME,
  readCsrfTokenFromCookie,
  setAccessToken,
} from '@/shared/api';

/** React Query key for the signed-in current-user document. */
export const CURRENT_USER_QUERY_KEY = Object.freeze(['auth', 'me']);

/**
 * Builds CSRF headers for cookie-authenticated auth mutations.
 * @returns {Record<string, string>}
 */
function csrfHeaders() {
  const csrfToken = readCsrfTokenFromCookie();
  if (!csrfToken) {
    return {};
  }
  return { [CSRF_HEADER_NAME]: csrfToken };
}

/**
 * Signs in with email and password; stores the access token in memory.
 * @param {string} email Account email.
 * @param {string} password Account password.
 * @returns {Promise<{
 *   accessToken: string,
 *   accessTokenExpiresInSeconds: number,
 *   user: object,
 * }>}
 */
export async function login(email, password) {
  const body = await apiRequest('/auth/login', {
    method: 'POST',
    body: { email, password },
    skipAuthRefresh: true,
  });
  const accessToken =
    body && typeof body === 'object'
      ? /** @type {{ accessToken?: unknown }} */ (body).accessToken
      : undefined;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('Login response missing access token');
  }
  setAccessToken(accessToken);
  return body;
}

/**
 * Loads the signed-in user (includes effective permissions).
 * @param {{ signal?: AbortSignal }} [options] Optional abort signal from React Query.
 * @returns {Promise<{
 *   id: string,
 *   email: string,
 *   displayName: string,
 *   orgId: string,
 *   roleIds: string[],
 *   permissions: string[],
 *   mustChangePassword: boolean,
 * }>}
 */
export async function fetchCurrentUser(options = {}) {
  return apiRequest('/auth/me', { signal: options.signal });
}

/**
 * Ends the server session and clears auth cookies (CSRF required).
 * @returns {Promise<void>}
 */
export async function logout() {
  await apiRequest('/auth/logout', {
    method: 'POST',
    headers: csrfHeaders(),
    skipAuthRefresh: true,
  });
}

/**
 * Changes the signed-in user's password.
 * @param {string} currentPassword Current password.
 * @param {string} newPassword New password meeting policy.
 * @returns {Promise<{
 *   passwordChanged: boolean,
 *   sessionsRevoked: boolean,
 *   reauthenticationRequired: boolean,
 * }>}
 */
export async function changePassword(currentPassword, newPassword) {
  return apiRequest('/auth/password/change', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}
