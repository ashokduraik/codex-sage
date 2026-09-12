/**
 * projectErrors helper coverage.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/shared/api';
import {
  correlationFromProjectError,
  isForbiddenProjectError,
  isNotFoundProjectError,
  messageFromProjectError,
  retryAfterFromProjectError,
} from './projectErrors.js';

describe('projectErrors', () => {
  it('prefers ApiError message and falls back for plain/unknown errors', () => {
    expect(
      messageFromProjectError(
        new ApiError({ status: 400, code: 'BAD', message: 'from api' }),
        'fallback',
      ),
    ).toBe('from api');
    expect(messageFromProjectError(new Error('plain'), 'fallback')).toBe('plain');
    expect(messageFromProjectError('x', 'fallback')).toBe('fallback');
  });

  it('reads correlation and retry-after only from ApiError', () => {
    const api = new ApiError({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'slow',
      correlationId: 'corr-1',
      retryAfterSeconds: 12,
    });
    expect(correlationFromProjectError(api)).toBe('corr-1');
    expect(retryAfterFromProjectError(api)).toBe(12);
    expect(correlationFromProjectError(new Error('x'))).toBe('');
    expect(retryAfterFromProjectError(new Error('x'))).toBeUndefined();
  });

  it('detects forbidden and not-found by status or code', () => {
    expect(
      isForbiddenProjectError(new ApiError({ status: 403, code: 'X', message: 'n' })),
    ).toBe(true);
    expect(
      isForbiddenProjectError(new ApiError({ status: 400, code: 'FORBIDDEN', message: 'n' })),
    ).toBe(true);
    expect(
      isForbiddenProjectError(new ApiError({ status: 400, code: 'X', message: 'n' })),
    ).toBe(false);
    expect(
      isNotFoundProjectError(new ApiError({ status: 404, code: 'X', message: 'n' })),
    ).toBe(true);
    expect(
      isNotFoundProjectError(new ApiError({ status: 400, code: 'NOT_FOUND', message: 'n' })),
    ).toBe(true);
    expect(isNotFoundProjectError(new Error('x'))).toBe(false);
  });
});
