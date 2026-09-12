import { describe, expect, it } from 'vitest';
import { ApiError } from '@/shared/api';
import {
  correlationFromError,
  hasPermission,
  messageFromError,
} from './adminErrors.js';

describe('adminErrors', () => {
  it('messageFromError prefers ApiError.message then Error.message then fallback', () => {
    expect(
      messageFromError(
        new ApiError({ status: 400, code: 'X', message: 'api' }),
        'fallback',
      ),
    ).toBe('api');
    expect(messageFromError(new Error('plain'), 'fallback')).toBe('plain');
    expect(messageFromError('nope', 'fallback')).toBe('fallback');
    expect(
      messageFromError(
        new ApiError({ status: 400, code: 'X', message: '' }),
        'fallback',
      ),
    ).toBe('fallback');
  });

  it('correlationFromError returns the id only for ApiError', () => {
    expect(
      correlationFromError(
        new ApiError({
          status: 500,
          code: 'X',
          message: 'm',
          correlationId: 'c-1',
        }),
      ),
    ).toBe('c-1');
    expect(correlationFromError(new Error('x'))).toBe('');
    expect(correlationFromError(null)).toBe('');
  });

  it('hasPermission checks array membership', () => {
    expect(hasPermission(['users.manage'], 'users.manage')).toBe(true);
    expect(hasPermission(['chat.ask'], 'users.manage')).toBe(false);
    expect(hasPermission(undefined, 'users.manage')).toBe(false);
  });
});
