import { describe, expect, it } from 'vitest';
import i18n from '@/shared/i18n';
import {
  ApiError,
  apiErrorFromNetworkFailure,
  apiErrorFromResponse,
  isRequestAbortedError,
  parseRetryAfterSeconds,
  RequestAbortedError,
  resolveRetryAfterSeconds,
} from './ApiError.js';

/**
 * Builds a minimal Response-like object for ApiError construction tests.
 * @param {number} status HTTP status.
 * @param {Record<string, string>} [headerMap] Response headers.
 * @returns {Response}
 */
function mockResponse(status, headerMap = {}) {
  return {
    status,
    headers: {
      get(name) {
        const key = Object.keys(headerMap).find(
          (candidate) => candidate.toLowerCase() === name.toLowerCase(),
        );
        return key ? headerMap[key] : null;
      },
    },
  };
}

describe('ApiError helpers', () => {
  it('carries code, message, and details from a well-formed envelope', () => {
    const error = apiErrorFromResponse(mockResponse(400, { 'X-Correlation-Id': 'REQ-1' }), {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'email is required',
        details: { field: 'email' },
        reference: 'REQ-ignored',
      },
    });
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('email is required');
    expect(error.details).toEqual({ field: 'email' });
    expect(error.correlationId).toBe('REQ-1');
  });

  it('falls back to error.reference when the correlation header is absent', () => {
    const error = apiErrorFromResponse(mockResponse(401), {
      error: {
        code: 'SESSION_EXPIRED',
        message: 'Session expired.',
        reference: 'REQ-2',
      },
    });
    expect(error.correlationId).toBe('REQ-2');
  });

  it('leaves correlationId undefined when neither header nor reference exists', () => {
    const error = apiErrorFromResponse(mockResponse(500), {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(error.correlationId).toBeUndefined();
  });

  it('uses UNEXPECTED and a localized fallback for empty or malformed bodies', () => {
    const error = apiErrorFromResponse(mockResponse(500), undefined);
    expect(error.code).toBe('UNEXPECTED');
    expect(error.message).toBe(i18n.t('errors.unexpected'));
    expect(error.message).not.toMatch(/fetch failed|terminated/i);
  });

  it('builds a NETWORK error with status 0 for transport failures', () => {
    const error = apiErrorFromNetworkFailure();
    expect(error.code).toBe('NETWORK');
    expect(error.status).toBe(0);
    expect(error.message).toBe(i18n.t('errors.network'));
  });

  it('attaches Retry-After delta-seconds when present', () => {
    const error = apiErrorFromResponse(
      mockResponse(429, { 'Retry-After': '30' }),
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests.',
        },
      },
    );
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('parses Retry-After HTTP-date into delay seconds', () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const seconds = parseRetryAfterSeconds(future);
    expect(seconds).toBeGreaterThanOrEqual(44);
    expect(seconds).toBeLessThanOrEqual(46);
  });

  it('reads retryAfterSec from details when the header is absent', () => {
    const headers = { get: () => null };
    expect(resolveRetryAfterSeconds(headers, { retryAfterSec: 12.2 })).toBe(13);
  });

  it('omits retryAfterSeconds when neither header nor details provide it', () => {
    const error = apiErrorFromResponse(mockResponse(429), {
      error: { code: 'RATE_LIMITED', message: 'Too many requests.' },
    });
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it('detects abort-shaped errors', () => {
    expect(isRequestAbortedError(new RequestAbortedError())).toBe(true);
    expect(isRequestAbortedError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isRequestAbortedError(new ApiError({ status: 0, code: 'NETWORK', message: 'x' }))).toBe(
      false,
    );
  });
});
