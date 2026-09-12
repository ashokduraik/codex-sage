/**
 * Shared API error message helpers for the projects feature.
 */
import { ApiError } from '@/shared/api';

/**
 * Resolves a user-facing error message from an API/client error.
 * @param {unknown} error Caught value.
 * @param {string} fallback Localized fallback.
 * @returns {string}
 */
export function messageFromProjectError(error, fallback) {
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
export function correlationFromProjectError(error) {
  if (error instanceof ApiError && error.correlationId) {
    return error.correlationId;
  }
  return '';
}

/**
 * Retry-after seconds when the API returned a rate limit hint.
 * @param {unknown} error Caught value.
 * @returns {number | undefined}
 */
export function retryAfterFromProjectError(error) {
  if (error instanceof ApiError && typeof error.retryAfterSeconds === 'number') {
    return error.retryAfterSeconds;
  }
  return undefined;
}

/**
 * True when the error is a 403/FORBIDDEN.
 * @param {unknown} error Caught value.
 * @returns {boolean}
 */
export function isForbiddenProjectError(error) {
  return error instanceof ApiError && (error.status === 403 || error.code === 'FORBIDDEN');
}

/**
 * True when the error is a 404/NOT_FOUND.
 * @param {unknown} error Caught value.
 * @returns {boolean}
 */
export function isNotFoundProjectError(error) {
  return error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND');
}
