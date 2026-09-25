import { describe, expect, it } from 'vitest';
import { ApiError } from '@/shared/api/ApiError.js';
import { queryRetryDelay, shouldRetryQuery } from '@/shared/lib/query-client.js';

describe('shouldRetryQuery', () => {
  it('returns false for 400, 403, 404, 409, 422, and 429', () => {
    for (const status of [400, 403, 404, 409, 422, 429]) {
      expect(
        shouldRetryQuery(
          0,
          new ApiError({ status, code: 'X', message: 'm' }),
        ),
      ).toBe(false);
    }
  });

  it('allows retries for 500 and network failures up to the cap', () => {
    expect(
      shouldRetryQuery(0, new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'm' })),
    ).toBe(true);
    expect(
      shouldRetryQuery(1, new ApiError({ status: 0, code: 'NETWORK', message: 'm' })),
    ).toBe(true);
    expect(
      shouldRetryQuery(2, new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'm' })),
    ).toBe(false);
  });

  it('retries unknown errors as temporary failures until the cap', () => {
    expect(shouldRetryQuery(0, new Error('boom'))).toBe(true);
    expect(shouldRetryQuery(2, new Error('boom'))).toBe(false);
  });
});

describe('queryRetryDelay', () => {
  it('grows exponentially and caps', () => {
    expect(queryRetryDelay(0)).toBe(1000);
    expect(queryRetryDelay(1)).toBe(2000);
    expect(queryRetryDelay(10)).toBe(30_000);
  });
});
