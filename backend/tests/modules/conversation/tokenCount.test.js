/**
 * Production tokenCount fails closed until a tokenizer package is wired.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';
import { countTokensForBudget } from '../../../src/modules/conversation/tokenCount.js';

describe('countTokensForBudget', () => {
  it('fails closed when no production tokenizer package is wired', () => {
    expect(() => countTokensForBudget('hello')).toThrow(ApiError);
    try {
      countTokensForBudget('hello');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_unavailable');
    }
  });
});
