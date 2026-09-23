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
  PROJECT_NOT_FOUND: Object.freeze({
    class: 'user',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'Project not found.',
  }),
  JOB_NOT_FOUND: Object.freeze({
    class: 'user',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'Job not found.',
  }),
  CONVERSATION_NOT_FOUND: Object.freeze({
    class: 'user',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'Conversation not found.',
  }),
  USER_NOT_FOUND: Object.freeze({
    class: 'user',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'User not found.',
  }),
  ROLE_NOT_FOUND: Object.freeze({
    class: 'user',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'Role not found.',
  }),
  MEMBER_NOT_FOUND: Object.freeze({
    class: 'user',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'Project member not found.',
  }),
  UNAUTHENTICATED: Object.freeze({
    class: 'authorization',
    httpStatus: 401,
    retryability: 'permanent',
    message: 'Authentication required.',
  }),
  INVALID_CREDENTIALS: Object.freeze({
    class: 'authorization',
    httpStatus: 401,
    retryability: 'user_action_required',
    message: 'Invalid email or credentials.',
  }),
  SESSION_EXPIRED: Object.freeze({
    class: 'authorization',
    httpStatus: 401,
    retryability: 'user_action_required',
    message: 'Session expired. Sign in again.',
  }),
  FORBIDDEN: Object.freeze({
    class: 'authorization',
    httpStatus: 403,
    retryability: 'permanent',
    message: 'You do not have permission to perform this action.',
  }),
  INVALID_CURRENT_PASSWORD: Object.freeze({
    class: 'authorization',
    httpStatus: 403,
    retryability: 'user_action_required',
    message: 'Current credential is incorrect.',
  }),
  PASSWORD_POLICY_VIOLATION: Object.freeze({
    class: 'user',
    httpStatus: 422,
    retryability: 'user_action_required',
    message: 'The new credential does not meet policy requirements.',
    allowDetails: true,
  }),
  PASSWORD_CHANGE_REQUIRED: Object.freeze({
    class: 'authorization',
    httpStatus: 403,
    retryability: 'user_action_required',
    message: 'You must update your credential before continuing.',
  }),
  CANNOT_MODIFY_SELF: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'You cannot perform this action on your own account.',
  }),
  LAST_ADMIN_REQUIRED: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'The organization must keep at least one active administrator.',
  }),
  IDENTITY_DUPLICATE_EMAIL: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'A user with this email already exists in the organization.',
  }),
  IDENTITY_DUPLICATE_ROLE_NAME: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'A role with this name already exists in the organization.',
  }),
  BUILT_IN_ROLE_IMMUTABLE: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'Built-in roles cannot be renamed, re-permissioned, or removed.',
  }),
  ROLE_IN_USE: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'The role is assigned to one or more active memberships.',
  }),
  UNKNOWN_PERMISSION: Object.freeze({
    class: 'user',
    httpStatus: 400,
    retryability: 'user_action_required',
    message: 'One or more permission keys are not in the catalog.',
    allowDetails: true,
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
  IDEMPOTENCY_KEY_REQUIRED: Object.freeze({
    class: 'user',
    httpStatus: 400,
    retryability: 'user_action_required',
    message: 'Idempotency-Key header is required for this operation.',
  }),
  IDEMPOTENCY_KEY_REUSE: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'Idempotency-Key was reused with a different request body.',
  }),
  IDEMPOTENCY_IN_FLIGHT: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'temporary',
    message: 'A request with this Idempotency-Key is still in progress.',
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
  INVALID_STATE_TRANSITION: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'The requested lifecycle transition is not allowed.',
    allowDetails: true,
  }),
  INVALID_JOB_TRANSITION: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'The requested job status transition is not allowed.',
    allowDetails: true,
  }),
  JOB_NOT_RETRYABLE: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message:
      'This upload cannot be retried. Fix the source and upload the project again.',
    allowDetails: true,
  }),
  JOB_RETRY_LIMIT_EXCEEDED: Object.freeze({
    class: 'user',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'This job has reached the maximum number of user-initiated retries.',
    allowDetails: true,
  }),
  UNKNOWN_SETTING: Object.freeze({
    class: 'user',
    httpStatus: 400,
    retryability: 'user_action_required',
    message: 'One or more setting keys are not registered.',
    allowDetails: true,
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
    message: 'Project knowledge is not available.',
  }),
  KNOWLEDGE_UPDATING: Object.freeze({
    class: 'knowledge',
    httpStatus: 503,
    retryability: 'temporary',
    message: 'Project knowledge is being updated.',
  }),
  SEARCH_RESULT_NOT_FOUND: Object.freeze({
    class: 'knowledge',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'Search result was not found for the current knowledge version.',
  }),
  CONTEXT_ACCOUNTING_UNAVAILABLE: Object.freeze({
    class: 'system',
    httpStatus: 503,
    retryability: 'temporary',
    message: 'Context accounting is temporarily unavailable.',
  }),
  SOURCE_ZIP_SLIP: Object.freeze({
    class: 'source',
    httpStatus: 400,
    retryability: 'user_action_required',
    message: 'The archive contains unsafe paths and cannot be accepted.',
  }),
  SOURCE_ZIP_INTEGRITY: Object.freeze({
    class: 'source',
    httpStatus: 400,
    retryability: 'user_action_required',
    message: 'The archive is truncated, corrupted, or cannot be read safely.',
  }),
  SOURCE_ARCHIVE_TOO_LARGE: Object.freeze({
    class: 'source',
    httpStatus: 400,
    retryability: 'user_action_required',
    message: 'The archive exceeds the maximum allowed size or entry count.',
  }),
  SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS: Object.freeze({
    class: 'source',
    httpStatus: 400,
    retryability: 'user_action_required',
    message:
      'No usable files remained after exclusions. Remove ignored paths and re-upload.',
  }),
  SOURCE_UNKNOWN_EXCLUSION_RULESET: Object.freeze({
    class: 'source',
    httpStatus: 500,
    retryability: 'permanent',
    message: 'The recorded exclusion ruleset is unknown and cannot be applied.',
  }),
  SOURCE_VERSION_NOT_FOUND: Object.freeze({
    class: 'source',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'Source version not found.',
  }),
  SOURCE_NOT_FOUND: Object.freeze({
    class: 'source',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'Source file not found.',
  }),
  CHANGE_SUMMARY_NOT_FOUND: Object.freeze({
    class: 'knowledge',
    httpStatus: 404,
    retryability: 'user_action_required',
    message: 'No change summary is available for this project.',
  }),
  UNSUPPORTED_MEDIA_TYPE: Object.freeze({
    class: 'source',
    httpStatus: 415,
    retryability: 'user_action_required',
    message: 'This file cannot be previewed as text.',
  }),
  CONNECTION_NOT_VERIFIED: Object.freeze({
    class: 'repository',
    httpStatus: 409,
    retryability: 'user_action_required',
    message: 'The repository could not be verified for attach.',
  }),
  CREDENTIAL_DECRYPT_FAILED: Object.freeze({
    class: 'repository',
    httpStatus: 503,
    retryability: 'temporary',
    message: 'Stored repository credentials could not be read.',
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
