import { describe, expect, it } from 'vitest';
import { ApiError } from '@/shared/api';
import { correlationFromUnknown, messageFromUnknown } from './authErrors.js';

describe('authErrors', () => {
  it('prefers ApiError.message', () => {
    expect(
      messageFromUnknown(
        new ApiError({ status: 401, code: 'X', message: 'from-api' }),
        'fallback',
      ),
    ).toBe('from-api');
  });

  it('uses Error.message when not an ApiError', () => {
    expect(messageFromUnknown(new Error('plain'), 'fallback')).toBe('plain');
  });

  it('uses the fallback for unknown values', () => {
    expect(messageFromUnknown('nope', 'fallback')).toBe('fallback');
    expect(messageFromUnknown(new Error(''), 'fallback')).toBe('fallback');
  });

  it('reads correlation ids from ApiError only', () => {
    expect(
      correlationFromUnknown(
        new ApiError({
          status: 401,
          code: 'X',
          message: 'm',
          correlationId: 'c-1',
        }),
      ),
    ).toBe('c-1');
    expect(correlationFromUnknown(new Error('x'))).toBe('');
    expect(
      correlationFromUnknown(
        new ApiError({ status: 401, code: 'X', message: 'm' }),
      ),
    ).toBe('');
  });
});
