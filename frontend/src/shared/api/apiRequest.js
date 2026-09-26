/**
 * Sole `fetch` wrapper for the frontend. Features reach the backend only through this module.
 */
import i18n from '@/shared/i18n';
import { API_BASE_URL } from './apiConfig.js';
import {
  ApiError,
  apiErrorFromNetworkFailure,
  apiErrorFromResponse,
  isRequestAbortedError,
  RequestAbortedError,
} from './ApiError.js';
import { clearSession, getAccessToken } from './apiSession.js';
import { refreshAccessToken } from './refreshClient.js';

/**
 * @typedef {object} ApiRequestOptions
 * @property {string} [method] HTTP method; defaults to GET.
 * @property {unknown} [body] JSON-serializable body when present.
 * @property {Record<string, string>} [headers] Extra headers merged onto defaults.
 * @property {AbortSignal} [signal] Cancellation signal from React Query.
 * @property {string} [idempotencyKey] Optional Idempotency-Key value.
 * @property {boolean} [skipAuthRefresh] When true, never enter the 401 refresh path.
 * @property {boolean} [credentials] Override credentials mode; defaults to `include`.
 */

/**
 * Performs one HTTP request against the backend.
 * @param {string} path API path relative to the base URL (e.g. `/auth/me`).
 * @param {ApiRequestOptions} [options] Request options.
 * @returns {Promise<unknown>} Parsed JSON body, or `undefined` for 204 / empty bodies.
 * @throws {ApiError} On HTTP and network failures.
 * @throws {RequestAbortedError} When the request was aborted.
 */
export async function apiRequest(path, options = {}) {
  return executeApiRequest(path, options, false);
}

/**
 * Internal request executor with a per-request refresh-retry flag.
 * @param {string} path API path.
 * @param {ApiRequestOptions} options Request options.
 * @param {boolean} hasRetriedAfterRefresh Whether this call already retried once.
 * @returns {Promise<unknown>}
 */
async function executeApiRequest(path, options, hasRetriedAfterRefresh) {
  const method = (options.method ?? 'GET').toUpperCase();
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/json',
    'Accept-Language': i18n.language || 'en',
    ...options.headers,
  };

  const token = getAccessToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  /** @type {RequestInit} */
  const init = {
    method,
    headers,
    credentials: options.credentials ?? 'include',
    signal: options.signal,
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(
      path.startsWith('/') ? `${API_BASE_URL}${path}` : `${API_BASE_URL}/${path}`,
      init,
    );
  } catch (error) {
    if (isRequestAbortedError(error) || options.signal?.aborted) {
      throw error instanceof Error && error.name === 'AbortError'
        ? error
        : new RequestAbortedError();
    }
    throw apiErrorFromNetworkFailure();
  }

  if (response.status === 401 && !options.skipAuthRefresh && !hasRetriedAfterRefresh) {
    try {
      await refreshAccessToken();
    } catch (refreshError) {
      if (isRequestAbortedError(refreshError)) {
        throw refreshError;
      }
      // Session already cleared inside refresh; surface the original request's error.
      let parsedBody;
      try {
        parsedBody = await response.clone().json();
      } catch {
        parsedBody = undefined;
      }
      throw apiErrorFromResponse(response, parsedBody);
    }
    return executeApiRequest(path, options, true);
  }

  if (response.status === 401 && !options.skipAuthRefresh && hasRetriedAfterRefresh) {
    clearSession();
    let parsedBody;
    try {
      parsedBody = await response.json();
    } catch {
      parsedBody = undefined;
    }
    throw apiErrorFromResponse(response, parsedBody);
  }

  if (!response.ok) {
    let parsedBody;
    try {
      parsedBody = await response.json();
    } catch {
      parsedBody = undefined;
    }
    throw apiErrorFromResponse(response, parsedBody);
  }

  if (response.status === 204) {
    return undefined;
  }

  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError({
      status: response.status,
      code: 'UNEXPECTED',
      message: i18n.t('errors.unexpected'),
      correlationId: response.headers.get('X-Correlation-Id') ?? undefined,
    });
  }
}
