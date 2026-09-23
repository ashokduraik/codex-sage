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
