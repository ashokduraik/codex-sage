import { describe, expect, it } from 'vitest';
import { ERROR_CODE_MESSAGES, getErrorMessageEntry } from './errorMessages.js';

describe('errorMessages', () => {
  it('maps every known catalog code to an i18n key and category', () => {
    expect(ERROR_CODE_MESSAGES.VALIDATION_ERROR.category).toBe('validation');
    expect(ERROR_CODE_MESSAGES.UNAUTHENTICATED.category).toBe('authorization');
    expect(ERROR_CODE_MESSAGES.RATE_LIMITED.category).toBe('rate_limited');
    expect(ERROR_CODE_MESSAGES.SERVICE_UNAVAILABLE.category).toBe('temporary');
    expect(ERROR_CODE_MESSAGES.INTERNAL_ERROR.category).toBe('system');
    expect(getErrorMessageEntry('SESSION_EXPIRED').i18nKey).toBe(
      'errors.codes.SESSION_EXPIRED',
    );
  });

  it('falls back to the generic unexpected entry for unknown codes', () => {
    const entry = getErrorMessageEntry('SOME_FUTURE_CODE');
    expect(entry.i18nKey).toBe('errors.unexpected');
    expect(entry.category).toBe('system');
  });
});
