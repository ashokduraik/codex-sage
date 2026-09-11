/**
 * Pure builder for the SSE terminal `error` event (architecture §9).
 * The stream-owning handler (phase 50) writes the frame — this module never touches reply.
 */
import {
  allowsErrorDetails,
  ERROR_CATALOG,
  getCatalogEntry,
  isKnownErrorCode,
} from './errorCatalog.js';

/**
 * @typedef {object} StreamErrorData
 * @property {string} code
 * @property {string} class
 * @property {string} retryability
 * @property {string} message
 * @property {string} reference
 * @property {unknown} [details]
 */

/**
 * Builds the terminal SSE error event payload from an error-like value.
 *
 * @param {{ code?: string, message?: string, details?: unknown, statusCode?: number }} error
 *   Error-like object (typically an ApiError).
 * @param {string} correlationId Reference to embed (same as X-Correlation-Id).
 * @returns {{ event: 'error', data: StreamErrorData }}
 */
export function buildStreamErrorEvent(error, correlationId) {
  const rawCode = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const code = isKnownErrorCode(rawCode) ? rawCode : 'INTERNAL_ERROR';
  const entry = getCatalogEntry(code) ?? ERROR_CATALOG.INTERNAL_ERROR;
  const message =
    entry.httpStatus >= 500 && code === 'INTERNAL_ERROR'
      ? entry.message
      : error?.message || entry.message;

  /** @type {StreamErrorData} */
  const data = {
    code,
    class: entry.class,
    retryability: entry.retryability,
    message,
    reference: correlationId,
  };

  if (allowsErrorDetails(code) && error?.details !== undefined) {
    data.details = error.details;
  }

  return { event: 'error', data };
}
