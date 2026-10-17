/**
 * Builds terminal SSE error frames after stream headers are sent.
 * Handlers write the frame; this module never touches `reply`.
 */
import { buildErrorEnvelope } from './errors.js';

/**
 * Builds a terminal SSE `error` event payload (ADR 0010 five fields).
 * Never includes chain-of-thought or provider stack traces in `data`.
 * @param {unknown} error Thrown failure (prefer ApiError).
 * @param {string} correlationId Request correlation / `error.reference`.
 * @returns {{ event: 'error', data: { code: string, class: string, retryability: string, message: string, reference: string } }}
 */
export function buildStreamErrorEvent(error, correlationId) {
  const reference = typeof correlationId === 'string' && correlationId.length > 0 ? correlationId : 'unknown';
  const mapped = buildErrorEnvelope(error, reference);
  const body = mapped.body.error;
  return {
    event: 'error',
    data: {
      code: body.code,
      class: body.class,
      retryability: body.retryability,
      message: body.message,
      reference: body.reference,
    },
  };
}
