import { ApiError } from '@/shared/api';

/**
 * Resolves a user-facing error message.
 * @param {unknown} error Caught value.
 * @param {string} fallback Localized fallback.
 * @returns {string}
 */
export function messageFromError(error, fallback) {
  if (error instanceof ApiError && error.message) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

/**
 * Correlation id from an API error when present.
 * @param {unknown} error Caught value.
 * @returns {string}
 */
export function correlationFromError(error) {
  if (error instanceof ApiError && error.correlationId) {
    return error.correlationId;
  }
  return '';
}

/**
 * True when the permission set includes the given key.
 * @param {string[] | undefined} permissions Caller permissions.
 * @param {string} permission Required permission.
 * @returns {boolean}
 */
export function hasPermission(permissions, permission) {
  return Array.isArray(permissions) && permissions.includes(permission);
}
