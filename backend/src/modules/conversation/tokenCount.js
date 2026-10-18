/**
 * Budget token counting for context accounting — sole production wiring for the
 * Qwen3 tokenizer package (ADR 0038). Callers must not inject count functions.
 */
import { fromPreTrained } from '@lenml/tokenizer-qwen3';
import { ApiError, apiErrorFromCaught } from '../../platform/errors.js';

/**
 * Max |node − host prompt_tokens| for parity fixtures wrapped as a Qwen chat
 * user turn plus assistant start (how the host measures prompt_tokens).
 */
export const TOKENIZER_PARITY_TOLERANCE_TOKENS = 8;

/** Lazy singleton — vocab is large; load once per process on first count. */
let budgetTokenizer = null;

const defaultLog = {
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

/**
 * Returns the process-wide Qwen3 tokenizer, loading it on first use.
 * @returns {ReturnType<typeof fromPreTrained>}
 * @throws {import('../../platform/errors.js').ApiError} CONTEXT_ACCOUNTING_UNAVAILABLE
 */
function loadBudgetTokenizer() {
  if (budgetTokenizer) {
    return budgetTokenizer;
  }
  try {
    budgetTokenizer = fromPreTrained();
    return budgetTokenizer;
  } catch (error) {
    throw apiErrorFromCaught('CONTEXT_ACCOUNTING_UNAVAILABLE', error, {
      details: { reason: 'tokenizer_unavailable' },
      log: defaultLog,
      logMessage: 'budget tokenizer init failed',
      fields: { reason: 'tokenizer_unavailable' },
    });
  }
}

/**
 * Counts tokens for context budgeting on segment content (no chat template).
 * @param {string} text Segment or message text.
 * @returns {number}
 * @throws {import('../../platform/errors.js').ApiError} CONTEXT_ACCOUNTING_UNAVAILABLE
 */
export function countTokensForBudget(text) {
  if (typeof text !== 'string') {
    throw ApiError.fromCode('CONTEXT_ACCOUNTING_UNAVAILABLE', {
      details: { reason: 'tokenizer_unavailable' },
    });
  }
  try {
    const tokenizer = loadBudgetTokenizer();
    const inputIds = tokenizer.encode(text, { add_special_tokens: false });
    if (!Array.isArray(inputIds)) {
      throw ApiError.fromCode('CONTEXT_ACCOUNTING_UNAVAILABLE', {
        details: { reason: 'tokenizer_unavailable' },
      });
    }
    return inputIds.length;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CONTEXT_ACCOUNTING_UNAVAILABLE') {
      throw error;
    }
    throw apiErrorFromCaught('CONTEXT_ACCOUNTING_UNAVAILABLE', error, {
      details: { reason: 'tokenizer_unavailable' },
      log: defaultLog,
      logMessage: 'budget tokenizer encode failed',
      fields: { reason: 'tokenizer_unavailable' },
    });
  }
}
