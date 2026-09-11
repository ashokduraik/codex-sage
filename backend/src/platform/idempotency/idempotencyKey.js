/**
 * Idempotency-Key validation and request-body hashing.
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../errors.js';
import {
  IDEMPOTENCY_HEADER_NAME,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from './idempotency.constants.js';

/**
 * Reads and validates the Idempotency-Key header.
 * @param {import('fastify').FastifyRequest} request Incoming request.
 * @returns {string} Validated key.
 * @throws {ApiError} IDEMPOTENCY_KEY_REQUIRED or VALIDATION_ERROR.
 */
export function readIdempotencyKey(request) {
  const raw = request.headers[IDEMPOTENCY_HEADER_NAME];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw ApiError.fromCode('IDEMPOTENCY_KEY_REQUIRED');
  }
  const key = raw.trim();
  if (
    key.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'Idempotency-Key',
          message: `must be ${IDEMPOTENCY_KEY_MIN_LENGTH}–${IDEMPOTENCY_KEY_MAX_LENGTH} chars [A-Za-z0-9._-]`,
        },
      ],
    });
  }
  return key;
}

/**
 * Stable SHA-256 hash of the request body used to detect key reuse with a different payload.
 * @param {unknown} body Parsed JSON body (or undefined).
 * @returns {string} Hex digest.
 */
export function hashIdempotencyRequestBody(body) {
  const canonical = JSON.stringify(body ?? null);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Returns UTF-8 byte length of a JSON-serialized value.
 * @param {unknown} value Value to measure.
 * @returns {number}
 */
export function measureJsonBodyBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
