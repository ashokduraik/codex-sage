/**
 * Single-flight refresh coordinator (D14: httpOnly cookie + CSRF header).
 */
import i18n from '@/shared/i18n';
import { API_BASE_URL } from './apiConfig.js';
import { ApiError, apiErrorFromNetworkFailure, apiErrorFromResponse, isRequestAbortedError, RequestAbortedError } from './ApiError.js';
import { clearSession, setAccessToken } from './apiSession.js';

/** Readable CSRF cookie name — must match backend `CSRF_COOKIE_NAME`. */
export const CSRF_COOKIE_NAME = 'csrfToken';

/** Header the browser echoes on refresh/logout — must match backend `CSRF_HEADER_NAME`. */
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

/** @type {Promise<string> | null} */
let refreshInFlight = null;

/**
 * Reads the double-submit CSRF token from `document.cookie`.
 * @returns {string | null}
 */
export function readCsrfTokenFromCookie() {
  if (typeof document === 'undefined') {
    return null;
  }
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${CSRF_COOKIE_NAME}=`)) {
      continue;
    }
    return decodeURIComponent(trimmed.slice(CSRF_COOKIE_NAME.length + 1));
  }
  return null;
}

/**
 * Performs one refresh call. Isolated so `apiRequest` can skip the 401 loop.
 * @returns {Promise<string>} New access token.
 * @throws {ApiError} When refresh fails.
 */
async function performRefresh() {
  const csrfToken = readCsrfTokenFromCookie();
  // No readable CSRF cookie ⇒ no prior login (or cookies cleared). Skip the network call
  // so boot does not trip `Missing csrf secret` on a public page load.
  if (!csrfToken) {
    clearSession();
    throw new ApiError({
      status: 401,
      code: 'UNAUTHENTICATED',
      message: i18n.t('errors.codes.UNAUTHENTICATED'),
    });
  }

  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/json',
    [CSRF_HEADER_NAME]: csrfToken,
  };

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers,
    });
  } catch (error) {
    if (isRequestAbortedError(error)) {
      throw error instanceof Error ? error : new RequestAbortedError();
    }
    clearSession();
    throw apiErrorFromNetworkFailure();
  }

  if (!response.ok) {
    let parsedBody;
    try {
      parsedBody = await response.json();
    } catch {
      parsedBody = undefined;
    }
    clearSession();
    throw apiErrorFromResponse(response, parsedBody);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    clearSession();
    throw new ApiError({
      status: response.status,
      code: 'UNEXPECTED',
      message: i18n.t('errors.unexpected'),
    });
  }

  const token = body && typeof body === 'object' ? /** @type {{ accessToken?: unknown }} */ (body).accessToken : undefined;
  if (typeof token !== 'string' || token === '') {
    clearSession();
    throw new ApiError({
      status: response.status,
      code: 'UNEXPECTED',
      message: i18n.t('errors.unexpected'),
    });
  }

  setAccessToken(token);
  return token;
}

/**
 * Ensures a single refresh is in flight; concurrent callers share the same promise.
 * On failure the session is cleared exactly once inside `performRefresh`.
 * @returns {Promise<string>} New access token.
 */
export function refreshAccessToken() {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * Test helper: clears the in-flight refresh promise.
 */
export function resetRefreshClientForTests() {
  refreshInFlight = null;
}
