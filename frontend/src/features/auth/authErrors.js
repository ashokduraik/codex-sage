import { ApiError } from '@/shared/api';

/**
 * Resolve a user-facing message from an unknown thrown value.
 * @param {unknown} err Caught error value.
 * @param {string} fallback Localized fallback when no message is present.
 * @returns {string} Error message string.
 */
export function messageFromUnknown(err, fallback) {
  if (err instanceof ApiError && err.message) {
    return err.message;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return fallback;
}

/**
 * Correlation id from an API error when the backend provided one.
 * @param {unknown} err Caught error value.
 * @returns {string} Correlation id or empty string.
 */
export function correlationFromUnknown(err) {
  if (err instanceof ApiError && err.correlationId) {
    return err.correlationId;
  }
  return '';
}
