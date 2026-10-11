/**
 * Budget token counting — the sole place a production tokenizer package will be
 * wired once evaluation parity is proven. Fails closed until then. Tests mock
 * this module; callers must not inject count functions through options bags.
 */
import { ApiError } from '../../platform/errors.js';

/**
 * Counts tokens for context budgeting.
 * @param {string} text Segment or message text.
 * @returns {number}
 * @throws {import('../../platform/errors.js').ApiError} CONTEXT_ACCOUNTING_UNAVAILABLE
 */
export function countTokensForBudget(text) {
  void text;
  throw ApiError.fromCode('CONTEXT_ACCOUNTING_UNAVAILABLE', {
    details: { reason: 'tokenizer_unavailable' },
  });
}
