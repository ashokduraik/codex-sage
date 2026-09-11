/**
 * Typed API failure carrying the backend envelope fields plus transport metadata.
 */
import i18n from '@/shared/i18n';

/** Response header carrying the request correlation reference (Phase 02). */
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/**
 * Error thrown when the caller aborted the request; must not be rendered as a failure.
 */
export class RequestAbortedError extends Error {
  /**
   * @param {string} [message] Optional abort message.
   */
  constructor(message = 'Request aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Parses `Retry-After` as delta-seconds or an HTTP-date into a delay in seconds.
 * @param {string | null} headerValue Raw header value.
 * @returns {number | undefined} Whole seconds until retry, or undefined when unusable.
 */
export function parseRetryAfterSeconds(headerValue) {
  if (headerValue == null || headerValue === '') {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  const seconds = Math.ceil((dateMs - Date.now()) / 1000);
  return seconds > 0 ? seconds : 0;
}

/**
 * Reads retry delay from the response header and/or `error.details.retryAfterSec`.
 * @param {Headers} headers Fetch response headers.
 * @param {unknown} details Envelope details object when present.
 * @returns {number | undefined}
 */
export function resolveRetryAfterSeconds(headers, details) {
  const fromHeader = parseRetryAfterSeconds(headers.get('Retry-After'));
  if (fromHeader !== undefined) {
    return fromHeader;
  }
  if (
    details &&
    typeof details === 'object' &&
    typeof /** @type {{ retryAfterSec?: unknown }} */ (details).retryAfterSec === 'number'
  ) {
    const sec = /** @type {{ retryAfterSec: number }} */ (details).retryAfterSec;
    if (Number.isFinite(sec) && sec >= 0) {
      return Math.ceil(sec);
    }
  }
  return undefined;
}

/**
 * @typedef {object} ApiErrorOptions
 * @property {number} status HTTP status, or `0` for network failures.
 * @property {string} code Machine-readable error code.
 * @property {string} message User-facing message (backend text or localized fallback).
 * @property {unknown} [details] Optional envelope details.
 * @property {string} [correlationId] Support reference when the backend provided one.
 * @property {number} [retryAfterSeconds] Seconds to wait after a rate limit.
 */

/**
 * Application API error. Extends `Error` so React Query and callers can `instanceof` it.
 */
export class ApiError extends Error {
  /**
   * @param {ApiErrorOptions} options Error fields.
   */
  constructor(options) {
    super(options.message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.correlationId = options.correlationId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * True when the failure is a user-initiated abort (do not render as an error).
 * @param {unknown} error Thrown value.
 * @returns {boolean}
 */
export function isRequestAbortedError(error) {
  if (error instanceof RequestAbortedError) {
    return true;
  }
  return (
    Boolean(error) &&
    typeof error === 'object' &&
    /** @type {{ name?: string }} */ (error).name === 'AbortError'
  );
}

/**
 * Builds an `ApiError` from a failed HTTP response.
 * Prefers the backend envelope message; falls back to localized unexpected copy.
 * @param {Response} response Fetch response.
 * @param {unknown} [parsedBody] Already-parsed JSON body, or undefined.
 * @returns {ApiError}
 */
export function apiErrorFromResponse(response, parsedBody) {
  const correlationFromHeader = response.headers.get(CORRELATION_ID_HEADER) ?? undefined;
  const envelope =
    parsedBody &&
    typeof parsedBody === 'object' &&
    /** @type {{ error?: unknown }} */ (parsedBody).error &&
    typeof /** @type {{ error: unknown }} */ (parsedBody).error === 'object'
      ? /** @type {{ error: { code?: unknown, message?: unknown, details?: unknown, reference?: unknown } }} */ (
          parsedBody
        ).error
      : null;

  if (
    envelope &&
    typeof envelope.code === 'string' &&
    typeof envelope.message === 'string'
  ) {
    const correlationId =
      correlationFromHeader ||
      (typeof envelope.reference === 'string' ? envelope.reference : undefined);
    return new ApiError({
      status: response.status,
      code: envelope.code,
      message: envelope.message,
      details: envelope.details,
      correlationId,
      retryAfterSeconds: resolveRetryAfterSeconds(response.headers, envelope.details),
    });
  }

  return new ApiError({
    status: response.status,
    code: 'UNEXPECTED',
    message: i18n.t('errors.unexpected'),
    correlationId: correlationFromHeader,
    retryAfterSeconds: resolveRetryAfterSeconds(response.headers, undefined),
  });
}

/**
 * Builds an `ApiError` for a rejected `fetch` (network / DNS / offline).
 * @returns {ApiError}
 */
export function apiErrorFromNetworkFailure() {
  return new ApiError({
    status: 0,
    code: 'NETWORK',
    message: i18n.t('errors.network'),
  });
}
