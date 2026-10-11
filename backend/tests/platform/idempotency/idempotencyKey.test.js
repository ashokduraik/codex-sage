/**
 * Unit tests for idempotency key validation and hashing.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';
import {
  readIdempotencyKey,
  measureJsonBodyBytes,
  hashIdempotencyRequestBody,
  IDEMPOTENCY_BODY_MAX_BYTES,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
} from '../../../src/platform/idempotency/index.js';

describe('readIdempotencyKey', () => {
  it('returns a trimmed valid key', () => {
    const key = readIdempotencyKey({
      headers: { 'idempotency-key': '  abcdefgh  ' },
    });
    expect(key).toBe('abcdefgh');
  });

  it('throws IDEMPOTENCY_KEY_REQUIRED when the header is missing', () => {
    expect(() => readIdempotencyKey({ headers: {} })).toThrow(ApiError);
    try {
      readIdempotencyKey({ headers: {} });
    } catch (err) {
      expect(err.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
  });

  it('throws VALIDATION_ERROR when the key is too short', () => {
    try {
      readIdempotencyKey({ headers: { 'idempotency-key': 'short' } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('VALIDATION_ERROR');
    }
  });

  it('throws VALIDATION_ERROR when the key has illegal characters', () => {
    try {
      readIdempotencyKey({ headers: { 'idempotency-key': 'bad key!!' } });
      expect.unreachable();
    } catch (err) {
      expect(err.code).toBe('VALIDATION_ERROR');
    }
  });

  it('throws VALIDATION_ERROR when the key exceeds max length', () => {
    const tooLong = 'a'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
    try {
      readIdempotencyKey({ headers: { 'idempotency-key': tooLong } });
      expect.unreachable();
    } catch (err) {
      expect(err.code).toBe('VALIDATION_ERROR');
    }
  });

  it('accepts the minimum and maximum lengths', () => {
    const min = 'a'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH);
    const max = 'b'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(readIdempotencyKey({ headers: { 'idempotency-key': min } })).toBe(min);
    expect(readIdempotencyKey({ headers: { 'idempotency-key': max } })).toBe(max);
  });
});

describe('hashIdempotencyRequestBody', () => {
  it('is stable for the same body and differs when the body changes', () => {
    const a = hashIdempotencyRequestBody({ email: 'a@example.com', roleIds: ['1'] });
    const b = hashIdempotencyRequestBody({ email: 'a@example.com', roleIds: ['1'] });
    const c = hashIdempotencyRequestBody({ email: 'b@example.com', roleIds: ['1'] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('measureJsonBodyBytes', () => {
  it('reports UTF-8 byte length and stays under the storage cap for small DTOs', () => {
    const bytes = measureJsonBodyBytes({ id: 'x', email: 'a@example.com' });
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(IDEMPOTENCY_BODY_MAX_BYTES);
  });
});
