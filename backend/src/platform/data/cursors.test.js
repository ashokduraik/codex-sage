/**
 * Unit tests for keyset cursor encode/decode.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../errors.js';
import { decodeCursor, encodeCursor } from './cursors.js';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a valid cursor payload', () => {
    const payload = { t: '2026-09-11T12:00:00.000Z', i: '6710c0a1f2b34c5d6e7f8091' };
    const encoded = encodeCursor(payload);
    expect(decodeCursor(encoded)).toEqual(payload);
  });

  it('rejects a malformed cursor with INVALID_CURSOR', () => {
    expect(() => decodeCursor('not-valid')).toThrow(ApiError);
    try {
      decodeCursor('!!!');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('INVALID_CURSOR');
    }
  });

  it('rejects an empty cursor', () => {
    expect(() => decodeCursor('')).toThrow(ApiError);
  });

  it('rejects encode when t or i is missing', () => {
    expect(() => encodeCursor({ t: '', i: 'abc' })).toThrow(ApiError);
    expect(() => encodeCursor({ t: '2026-01-01T00:00:00.000Z', i: '' })).toThrow(ApiError);
  });
});
