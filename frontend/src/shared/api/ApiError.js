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
  if (details && typeof details === 'object' && typeof (/** @type {{ retryAfterSec?: unknown }} */ (details).retryAfterSec) === 'number') {
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
  return Boolean(error) && typeof error === 'object' && /** @type {{ name?: string }} */ (error).name === 'AbortError';
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
    typeof (/** @type {{ error: unknown }} */ (parsedBody).error) === 'object'
      ? /** @type {{ error: { code?: unknown, message?: unknown, details?: unknown, reference?: unknown } }} */ (parsedBody).error
      : null;

  if (envelope && typeof envelope.code === 'string' && typeof envelope.message === 'string') {
    const correlationId = correlationFromHeader || (typeof envelope.reference === 'string' ? envelope.reference : undefined);
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

/**
 * Maps backend error codes to i18n keys and UI failure categories.
 * The backend message remains what is shown; this map classifies the failure.
 */

/**
 * @typedef {'authorization' | 'validation' | 'temporary' | 'rate_limited' | 'system'} ErrorCategory
 */

/**
 * @typedef {object} ErrorMessageEntry
 * @property {string} i18nKey Key under `errors.codes.*` (or a top-level errors key).
 * @property {ErrorCategory} category Failure category for next-action UI.
 */

/** @type {Readonly<Record<string, Readonly<ErrorMessageEntry>>>} */
export const ERROR_CODE_MESSAGES = Object.freeze({
  VALIDATION_ERROR: Object.freeze({
    i18nKey: 'errors.codes.VALIDATION_ERROR',
    category: 'validation',
  }),
  NOT_FOUND: Object.freeze({
    i18nKey: 'errors.codes.NOT_FOUND',
    category: 'validation',
  }),
  UNAUTHENTICATED: Object.freeze({
    i18nKey: 'errors.codes.UNAUTHENTICATED',
    category: 'authorization',
  }),
  INVALID_CREDENTIALS: Object.freeze({
    i18nKey: 'errors.codes.INVALID_CREDENTIALS',
    category: 'authorization',
  }),
  SESSION_EXPIRED: Object.freeze({
    i18nKey: 'errors.codes.SESSION_EXPIRED',
    category: 'authorization',
  }),
  FORBIDDEN: Object.freeze({
    i18nKey: 'errors.codes.FORBIDDEN',
    category: 'authorization',
  }),
  INVALID_CURRENT_PASSWORD: Object.freeze({
    i18nKey: 'errors.codes.INVALID_CURRENT_PASSWORD',
    category: 'authorization',
  }),
  PASSWORD_POLICY_VIOLATION: Object.freeze({
    i18nKey: 'errors.codes.PASSWORD_POLICY_VIOLATION',
    category: 'validation',
  }),
  PASSWORD_CHANGE_REQUIRED: Object.freeze({
    i18nKey: 'errors.codes.PASSWORD_CHANGE_REQUIRED',
    category: 'authorization',
  }),
  CANNOT_MODIFY_SELF: Object.freeze({
    i18nKey: 'errors.codes.CANNOT_MODIFY_SELF',
    category: 'validation',
  }),
  LAST_ADMIN_REQUIRED: Object.freeze({
    i18nKey: 'errors.codes.LAST_ADMIN_REQUIRED',
    category: 'validation',
  }),
  IDENTITY_DUPLICATE_EMAIL: Object.freeze({
    i18nKey: 'errors.codes.IDENTITY_DUPLICATE_EMAIL',
    category: 'validation',
  }),
  IDENTITY_DUPLICATE_ROLE_NAME: Object.freeze({
    i18nKey: 'errors.codes.IDENTITY_DUPLICATE_ROLE_NAME',
    category: 'validation',
  }),
  IDENTITY_DUPLICATE_ROLE_CODE: Object.freeze({
    i18nKey: 'errors.codes.IDENTITY_DUPLICATE_ROLE_CODE',
    category: 'validation',
  }),
  IDENTITY_DUPLICATE_USER_CODE: Object.freeze({
    i18nKey: 'errors.codes.IDENTITY_DUPLICATE_USER_CODE',
    category: 'validation',
  }),
  IDENTITY_DUPLICATE_ORG_CODE: Object.freeze({
    i18nKey: 'errors.codes.IDENTITY_DUPLICATE_ORG_CODE',
    category: 'validation',
  }),
  BUILT_IN_ROLE_IMMUTABLE: Object.freeze({
    i18nKey: 'errors.codes.BUILT_IN_ROLE_IMMUTABLE',
    category: 'validation',
  }),
  ROLE_IN_USE: Object.freeze({
    i18nKey: 'errors.codes.ROLE_IN_USE',
    category: 'validation',
  }),
  UNKNOWN_PERMISSION: Object.freeze({
    i18nKey: 'errors.codes.UNKNOWN_PERMISSION',
    category: 'validation',
  }),
  PROJECT_NAME_TAKEN: Object.freeze({
    i18nKey: 'errors.codes.PROJECT_NAME_TAKEN',
    category: 'validation',
  }),
  INVALID_STATE_TRANSITION: Object.freeze({
    i18nKey: 'errors.codes.INVALID_STATE_TRANSITION',
    category: 'validation',
  }),
  CONFLICT: Object.freeze({
    i18nKey: 'errors.codes.CONFLICT',
    category: 'validation',
  }),
  RATE_LIMITED: Object.freeze({
    i18nKey: 'errors.codes.RATE_LIMITED',
    category: 'rate_limited',
  }),
  IDEMPOTENCY_KEY_REQUIRED: Object.freeze({
    i18nKey: 'errors.codes.IDEMPOTENCY_KEY_REQUIRED',
    category: 'validation',
  }),
  IDEMPOTENCY_KEY_REUSE: Object.freeze({
    i18nKey: 'errors.codes.IDEMPOTENCY_KEY_REUSE',
    category: 'validation',
  }),
  IDEMPOTENCY_IN_FLIGHT: Object.freeze({
    i18nKey: 'errors.codes.IDEMPOTENCY_IN_FLIGHT',
    category: 'temporary',
  }),
  INTERNAL_ERROR: Object.freeze({
    i18nKey: 'errors.codes.INTERNAL_ERROR',
    category: 'system',
  }),
  SERVICE_UNAVAILABLE: Object.freeze({
    i18nKey: 'errors.codes.SERVICE_UNAVAILABLE',
    category: 'temporary',
  }),
  MONGO_UNAVAILABLE: Object.freeze({
    i18nKey: 'errors.codes.MONGO_UNAVAILABLE',
    category: 'temporary',
  }),
  TENANT_SCOPE_MISSING: Object.freeze({
    i18nKey: 'errors.codes.TENANT_SCOPE_MISSING',
    category: 'authorization',
  }),
  INVALID_CURSOR: Object.freeze({
    i18nKey: 'errors.codes.INVALID_CURSOR',
    category: 'validation',
  }),
  BOOTSTRAP_FAILED: Object.freeze({
    i18nKey: 'errors.codes.BOOTSTRAP_FAILED',
    category: 'system',
  }),
  KNOWLEDGE_UNAVAILABLE: Object.freeze({
    i18nKey: 'errors.codes.KNOWLEDGE_UNAVAILABLE',
    category: 'temporary',
  }),
  JOB_NOT_FOUND: Object.freeze({
    i18nKey: 'errors.codes.JOB_NOT_FOUND',
    category: 'validation',
  }),
  JOB_NOT_RETRYABLE: Object.freeze({
    i18nKey: 'errors.codes.JOB_NOT_RETRYABLE',
    category: 'validation',
  }),
  JOB_RETRY_LIMIT_EXCEEDED: Object.freeze({
    i18nKey: 'errors.codes.JOB_RETRY_LIMIT_EXCEEDED',
    category: 'validation',
  }),
  INVALID_JOB_TRANSITION: Object.freeze({
    i18nKey: 'errors.codes.INVALID_JOB_TRANSITION',
    category: 'validation',
  }),
  CONTEXT_ACCOUNTING_UNAVAILABLE: Object.freeze({
    i18nKey: 'errors.codes.CONTEXT_ACCOUNTING_UNAVAILABLE',
    category: 'temporary',
  }),
  CONTEXT_BUDGET_EXCEEDED: Object.freeze({
    i18nKey: 'errors.codes.CONTEXT_BUDGET_EXCEEDED',
    category: 'validation',
  }),
  NETWORK: Object.freeze({
    i18nKey: 'errors.network',
    category: 'temporary',
  }),
  UNEXPECTED: Object.freeze({
    i18nKey: 'errors.unexpected',
    category: 'system',
  }),
});

/**
 * Resolves i18n key and category for a backend (or client) error code.
 * Unknown codes use the generic system category.
 * @param {string} code Error code.
 * @returns {Readonly<ErrorMessageEntry>}
 */
export function getErrorMessageEntry(code) {
  return (
    ERROR_CODE_MESSAGES[code] ??
    Object.freeze({
      i18nKey: 'errors.unexpected',
      category: /** @type {ErrorCategory} */ ('system'),
    })
  );
}

/**
 * Resolves a user-facing message from an unknown thrown value.
 * @param {unknown} error Caught error value.
 * @param {string} fallback Localized fallback when no message is present.
 * @returns {string}
 */
export function messageFromUnknown(error, fallback) {
  if (error instanceof ApiError && error.message) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

/**
 * Correlation id from an API error when the backend provided one.
 * @param {unknown} error Caught error value.
 * @returns {string}
 */
export function correlationFromUnknown(error) {
  if (error instanceof ApiError && error.correlationId) {
    return error.correlationId;
  }
  return '';
}

/**
 * Retry-after seconds when the API returned a rate limit hint.
 * @param {unknown} error Caught error value.
 * @returns {number | undefined}
 */
export function retryAfterFromUnknown(error) {
  if (error instanceof ApiError && typeof error.retryAfterSeconds === 'number') {
    return error.retryAfterSeconds;
  }
  return undefined;
}

/**
 * True when the error is a 403/FORBIDDEN.
 * @param {unknown} error Caught error value.
 * @returns {boolean}
 */
export function isForbiddenApiError(error) {
  return error instanceof ApiError && (error.status === 403 || error.code === 'FORBIDDEN');
}

/**
 * True when the error is a 404/NOT_FOUND.
 * @param {unknown} error Caught error value.
 * @returns {boolean}
 */
export function isNotFoundApiError(error) {
  return error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND');
}
