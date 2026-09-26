/**
 * Progress-capable multipart upload using XMLHttpRequest (fetch cannot report upload bytes).
 */
import i18n from '@/shared/i18n';
import { API_BASE_URL } from './apiConfig.js';
import { ApiError, apiErrorFromNetworkFailure, apiErrorFromResponse, isRequestAbortedError, RequestAbortedError } from './ApiError.js';
import { clearSession, getAccessToken } from './apiSession.js';
import { refreshAccessToken } from './refreshClient.js';

/**
 * @typedef {object} ApiUploadOptions
 * @property {FormData} body Multipart body (Content-Type is set by the browser).
 * @property {string} [method] HTTP method; defaults to POST.
 * @property {Record<string, string>} [headers] Extra headers.
 * @property {AbortSignal} [signal] Cancellation signal.
 * @property {string} [idempotencyKey] Required by backend upload routes.
 * @property {boolean} [skipAuthRefresh] When true, never enter the 401 refresh path.
 * @property {(progress: { loaded: number, total: number }) => void} [onUploadProgress]
 *   Byte-level upload progress.
 */

/**
 * Uploads FormData and reports byte progress.
 * @param {string} path API path relative to the base URL.
 * @param {ApiUploadOptions} options Upload options.
 * @returns {Promise<unknown>} Parsed JSON body.
 */
export async function apiUpload(path, options) {
  return executeApiUpload(path, options, false);
}

/**
 * @param {string} path API path.
 * @param {ApiUploadOptions} options Upload options.
 * @param {boolean} hasRetriedAfterRefresh Whether this call already retried once.
 * @returns {Promise<unknown>}
 */
async function executeApiUpload(path, options, hasRetriedAfterRefresh) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open((options.method ?? 'POST').toUpperCase(), path.startsWith('/') ? `${API_BASE_URL}${path}` : `${API_BASE_URL}/${path}`);
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Accept-Language', i18n.language || 'en');
    const token = getAccessToken();
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }
    if (options.idempotencyKey) {
      xhr.setRequestHeader('Idempotency-Key', options.idempotencyKey);
    }
    if (options.headers) {
      for (const [name, value] of Object.entries(options.headers)) {
        xhr.setRequestHeader(name, value);
      }
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof options.onUploadProgress === 'function') {
        options.onUploadProgress({ loaded: event.loaded, total: event.total });
      }
    };

    const abortFromSignal = () => {
      xhr.abort();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new RequestAbortedError());
        return;
      }
      options.signal.addEventListener('abort', abortFromSignal, { once: true });
    }

    xhr.onload = () => {
      options.signal?.removeEventListener('abort', abortFromSignal);
      void settleXhr(xhr, path, options, hasRetriedAfterRefresh).then(resolve, reject);
    };
    xhr.onerror = () => {
      options.signal?.removeEventListener('abort', abortFromSignal);
      reject(apiErrorFromNetworkFailure());
    };
    xhr.onabort = () => {
      options.signal?.removeEventListener('abort', abortFromSignal);
      reject(new RequestAbortedError());
    };

    xhr.send(options.body);
  });
}

/**
 * Interprets an XHR completion, including a single 401 refresh retry.
 * @param {XMLHttpRequest} xhr Completed request.
 * @param {string} path API path.
 * @param {ApiUploadOptions} options Original options.
 * @param {boolean} hasRetriedAfterRefresh Refresh flag.
 * @returns {Promise<unknown>}
 */
async function settleXhr(xhr, path, options, hasRetriedAfterRefresh) {
  const responseLike = {
    status: xhr.status,
    ok: xhr.status >= 200 && xhr.status < 300,
    headers: {
      /**
       * @param {string} name Header name.
       * @returns {string | null}
       */
      get(name) {
        return xhr.getResponseHeader(name);
      },
    },
  };
  let parsedBody;
  if (xhr.responseText) {
    try {
      parsedBody = JSON.parse(xhr.responseText);
    } catch {
      parsedBody = undefined;
    }
  }

  if (xhr.status === 401 && !options.skipAuthRefresh && !hasRetriedAfterRefresh) {
    try {
      await refreshAccessToken();
    } catch (refreshError) {
      if (isRequestAbortedError(refreshError)) {
        throw refreshError;
      }
      throw apiErrorFromResponse(responseLike, parsedBody);
    }
    return executeApiUpload(path, options, true);
  }

  if (xhr.status === 401 && !options.skipAuthRefresh && hasRetriedAfterRefresh) {
    clearSession();
    throw apiErrorFromResponse(responseLike, parsedBody);
  }

  if (xhr.status < 200 || xhr.status >= 300) {
    throw apiErrorFromResponse(responseLike, parsedBody);
  }

  if (xhr.status === 204 || !xhr.responseText) {
    return undefined;
  }
  if (parsedBody === undefined) {
    throw new ApiError({
      status: xhr.status,
      code: 'UNEXPECTED',
      message: i18n.t('errors.unexpected'),
      correlationId: xhr.getResponseHeader('X-Correlation-Id') ?? undefined,
    });
  }
  return parsedBody;
}
