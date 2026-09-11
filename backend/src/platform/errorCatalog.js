/**
 * Single source of truth for API error codes.
 * Every code used in the backend must be registered here — nowhere else may define codes.
 */

/** @typedef {'user' | 'authorization' | 'source' | 'repository' | 'processing' | 'knowledge' | 'system' | 'temporary'} ErrorClass */
/** @typedef {'temporary' | 'permanent' | 'user_action_required'} Retryability */

/**
 * @typedef {object} CatalogEntry
 * @property {ErrorClass} class
 * @property {number} httpStatus
 * @property {Retryability} retryability
 * @property {string} message Stable English default; never contains secrets, paths, or hosts.
 * @property {boolean} [allowDetails] When true, non-sensitive details may appear in the body.
 */

/** Stable code for Mongo readiness failures (shared with mongo.js). */
export const MONGO_UNAVAILABLE_CODE = 'MONGO_UNAVAILABLE';

/**
 * Frozen catalog: code → class, HTTP status, retryability, default message.
 * @type {Readonly<Record<string, Readonly<CatalogEntry>>>}
 */
export const ERROR_CATALOG = Object.freeze({
  VALIDATION_ERROR: Object.freeze({
    class: 'user',
    httpStatus: 400,
    retryability: 'user_action_required',
    message: 'Request validation failed.',
    allowDetails: true,
  }),
  NOT_FOUND: Object.freeze({
    class: 'user',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'Route not found.',
  }),
  UNAUTHENTICATED: Object.freeze({
    class: 'authorization',
    httpStatus: 401,
    retryability: 'permanent',
    message: 'Authentication required.',
  }),
  FORBIDDEN: Object.freeze({
    class: 'authorization',
    httpStatus: 403,
    retryability: 'permanent',
    message: 'You do not have permission to perform this action.',
  }),
  CONFLICT: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'The request conflicts with the current state.',
  }),
  RATE_LIMITED: Object.freeze({
    class: 'user',
    httpStatus: 429,
    retryability: 'temporary',
    message: 'Too many requests. Try again later.',
    allowDetails: true,
  }),
  IDEMPOTENCY_CONFLICT: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'Idempotency key conflict.',
  }),
  INTERNAL_ERROR: Object.freeze({
    class: 'system',
    httpStatus: 500,
    retryability: 'permanent',
    message: 'Internal server error',
  }),
  SERVICE_UNAVAILABLE: Object.freeze({
    class: 'temporary',
    httpStatus: 503,
    retryability: 'temporary',
    message: 'Service temporarily unavailable.',
  }),
  [MONGO_UNAVAILABLE_CODE]: Object.freeze({
    class: 'temporary',
    httpStatus: 503,
    retryability: 'temporary',
    message: 'Database temporarily unavailable.',
  }),
  TENANT_SCOPE_MISSING: Object.freeze({
    class: 'authorization',
    httpStatus: 403,
    retryability: 'permanent',
    message: 'Tenant scope is required for this operation.',
  }),
  INVALID_CURSOR: Object.freeze({
    class: 'user',
    httpStatus: 400,
    retryability: 'user_action_required',
    message: 'Pagination cursor is invalid.',
  }),
  BOOTSTRAP_FAILED: Object.freeze({
    class: 'system',
    httpStatus: 500,
    retryability: 'permanent',
    message: 'Bootstrap seed failed.',
  }),
  KNOWLEDGE_UNAVAILABLE: Object.freeze({
    class: 'knowledge',
    httpStatus: 503,
    retryability: 'temporary',
    message: 'Project knowledge is being updated.',
  }),
  CONTEXT_ACCOUNTING_UNAVAILABLE: Object.freeze({
    class: 'system',
    httpStatus: 503,
    retryability: 'temporary',
    message: 'Context accounting is temporarily unavailable.',
  }),
});

/**
 * Returns whether `code` is registered in the catalog.
 * @param {string} code Candidate error code.
 * @returns {boolean}
 */
export function isKnownErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code);
}

/**
 * Looks up a catalog entry by code.
 * @param {string} code Error code.
 * @returns {Readonly<CatalogEntry> | undefined}
 */
export function getCatalogEntry(code) {
  if (!isKnownErrorCode(code)) {
    return undefined;
  }
  return ERROR_CATALOG[code];
}

/**
 * True when the catalog allows non-sensitive `details` for this code.
 * @param {string} code Error code.
 * @returns {boolean}
 */
export function allowsErrorDetails(code) {
  const entry = getCatalogEntry(code);
  return entry?.allowDetails === true;
}
