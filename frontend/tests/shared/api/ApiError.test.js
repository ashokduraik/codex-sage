import i18n from '@/shared/i18n/index';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  isNotFoundApiError,
  messageFromUnknown,
  ERROR_CODE_MESSAGES,
  isForbiddenApiError,
  RequestAbortedError,
  apiErrorFromResponse,
  getErrorMessageEntry,
  isRequestAbortedError,
  retryAfterFromUnknown,
  correlationFromUnknown,
  parseRetryAfterSeconds,
  resolveRetryAfterSeconds,
  apiErrorFromNetworkFailure,
} from '@/shared/api/ApiError.js';

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
        const key = Object.keys(headerMap).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
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
    const error = apiErrorFromResponse(mockResponse(429, { 'Retry-After': '30' }), {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests.',
      },
    });
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
    expect(isRequestAbortedError(new ApiError({ status: 0, code: 'NETWORK', message: 'x' }))).toBe(false);
  });
});

describe('errorMessages', () => {
  it('maps every known catalog code to an i18n key and category', () => {
    expect(ERROR_CODE_MESSAGES.VALIDATION_ERROR.category).toBe('validation');
    expect(ERROR_CODE_MESSAGES.UNAUTHENTICATED.category).toBe('authorization');
    expect(ERROR_CODE_MESSAGES.RATE_LIMITED.category).toBe('rate_limited');
    expect(ERROR_CODE_MESSAGES.SERVICE_UNAVAILABLE.category).toBe('temporary');
    expect(ERROR_CODE_MESSAGES.INTERNAL_ERROR.category).toBe('system');
    expect(getErrorMessageEntry('SESSION_EXPIRED').i18nKey).toBe('errors.codes.SESSION_EXPIRED');
  });

  it('falls back to the generic unexpected entry for unknown codes', () => {
    const entry = getErrorMessageEntry('SOME_FUTURE_CODE');
    expect(entry.i18nKey).toBe('errors.unexpected');
    expect(entry.category).toBe('system');
  });
});

describe('unknownError', () => {
  it('prefers ApiError message then Error.message then fallback', () => {
    expect(messageFromUnknown(new ApiError({ status: 401, code: 'X', message: 'from-api' }), 'fallback')).toBe('from-api');
    expect(messageFromUnknown(new Error('plain'), 'fallback')).toBe('plain');
    expect(messageFromUnknown('nope', 'fallback')).toBe('fallback');
    expect(messageFromUnknown(new Error(''), 'fallback')).toBe('fallback');
    expect(messageFromUnknown(new ApiError({ status: 400, code: 'X', message: '' }), 'fallback')).toBe('fallback');
  });

  it('reads correlation and retry-after only from ApiError', () => {
    const api = new ApiError({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'slow',
      correlationId: 'corr-1',
      retryAfterSeconds: 12,
    });
    expect(correlationFromUnknown(api)).toBe('corr-1');
    expect(retryAfterFromUnknown(api)).toBe(12);
    expect(correlationFromUnknown(new Error('x'))).toBe('');
    expect(correlationFromUnknown(null)).toBe('');
    expect(correlationFromUnknown(new ApiError({ status: 401, code: 'X', message: 'm' }))).toBe('');
    expect(retryAfterFromUnknown(new Error('x'))).toBeUndefined();
  });

  it('detects forbidden and not-found by status or code', () => {
    expect(isForbiddenApiError(new ApiError({ status: 403, code: 'X', message: 'n' }))).toBe(true);
    expect(isForbiddenApiError(new ApiError({ status: 400, code: 'FORBIDDEN', message: 'n' }))).toBe(true);
    expect(isForbiddenApiError(new ApiError({ status: 400, code: 'X', message: 'n' }))).toBe(false);
    expect(isNotFoundApiError(new ApiError({ status: 404, code: 'X', message: 'n' }))).toBe(true);
    expect(isNotFoundApiError(new ApiError({ status: 400, code: 'NOT_FOUND', message: 'n' }))).toBe(true);
    expect(isNotFoundApiError(new Error('x'))).toBe(false);
  });
});
