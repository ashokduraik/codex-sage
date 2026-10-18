/**
 * Production tokenCount uses @lenml/tokenizer-qwen3; parity vs llm-host fixtures.
 */
import { ApiError } from '../../../src/platform/errors.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countTokensForBudget, TOKENIZER_PARITY_TOLERANCE_TOKENS } from '../../../src/modules/conversation/tokenCount.js';

/** Same strings as scripts/measure-llm-host.mjs PARITY_FIXTURES. */
const PARITY_FIXTURES = Object.freeze({
  system: 'You are a grounded project assistant. Cite evidence ids. Do not invent paths or APIs.',
  turns: 'User: How does login refresh the session?\nAssistant: Refresh uses the httpOnly cookie and rotates the hash.',
  toolJson: JSON.stringify({
    tool: 'explore_code',
    path: 'backend/src/modules/access/auth.js',
    excerpt: 'export async function refreshSession(request) { return rotate(request); }',
  }),
  codeExcerpt: [
    'export async function refreshSession(request) {',
    '  const session = await loadSession(request.cookies.refresh);',
    '  if (!session) throw unauthorized();',
    '  return rotate(session);',
    '}',
  ].join('\n'),
});

/** Host prompt_tokens from docs/evaluation/llm-host.raw.json (OpenAI path). */
const HOST_PROMPT_TOKENS = Object.freeze({
  system: 29,
  turns: 33,
  toolJson: 42,
  codeExcerpt: 47,
});

/**
 * Wraps fixture text the way the host chat-completions path accounts for
 * prompt_tokens (Qwen user turn + assistant generation start).
 * @param {string} content Fixture body.
 * @returns {string}
 */
function wrapAsHostUserPrompt(content) {
  return `<|im_start|>user\n${content}<|im_end|>\n<|im_start|>assistant\n`;
}

describe('countTokensForBudget', () => {
  it('returns a positive token count for plain segment content', () => {
    const count = countTokensForBudget('hello');
    expect(count).toBeGreaterThan(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  it('returns zero for an empty string', () => {
    expect(countTokensForBudget('')).toBe(0);
  });

  it('matches host prompt_tokens within tolerance when fixtures use chat wrap', () => {
    for (const [name, content] of Object.entries(PARITY_FIXTURES)) {
      const nodeCount = countTokensForBudget(wrapAsHostUserPrompt(content));
      const hostPromptTokens = HOST_PROMPT_TOKENS[name];
      const delta = Math.abs(nodeCount - hostPromptTokens);
      expect(delta, `${name}: node=${nodeCount} host=${hostPromptTokens} delta=${delta}`).toBeLessThanOrEqual(TOKENIZER_PARITY_TOLERANCE_TOKENS);
    }
  });

  it('throws CONTEXT_ACCOUNTING_UNAVAILABLE for non-string input', () => {
    expect(() => countTokensForBudget(null)).toThrow(ApiError);
    try {
      countTokensForBudget(null);
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_unavailable');
    }
  });
});

describe('countTokensForBudget tokenizer package failures', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@lenml/tokenizer-qwen3');
  });

  it('throws CONTEXT_ACCOUNTING_UNAVAILABLE when fromPreTrained fails', async () => {
    vi.resetModules();
    vi.doMock('@lenml/tokenizer-qwen3', () => ({
      fromPreTrained: () => {
        throw new Error('vocab missing');
      },
    }));
    const { countTokensForBudget: countWithBrokenInit } = await import('../../../src/modules/conversation/tokenCount.js');
    try {
      countWithBrokenInit('hello');
      expect.fail('expected CONTEXT_ACCOUNTING_UNAVAILABLE');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_unavailable');
    }
  });

  it('throws CONTEXT_ACCOUNTING_UNAVAILABLE when encode fails', async () => {
    vi.resetModules();
    vi.doMock('@lenml/tokenizer-qwen3', () => ({
      fromPreTrained: () => ({
        encode: () => {
          throw new Error('encode blew up');
        },
      }),
    }));
    const { countTokensForBudget: countWithBrokenEncode } = await import('../../../src/modules/conversation/tokenCount.js');
    try {
      countWithBrokenEncode('hello');
      expect.fail('expected CONTEXT_ACCOUNTING_UNAVAILABLE');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_unavailable');
    }
  });

  it('throws CONTEXT_ACCOUNTING_UNAVAILABLE when encode returns a non-array', async () => {
    vi.resetModules();
    vi.doMock('@lenml/tokenizer-qwen3', () => ({
      fromPreTrained: () => ({
        encode: () => null,
      }),
    }));
    const { countTokensForBudget: countWithBadEncode } = await import('../../../src/modules/conversation/tokenCount.js');
    try {
      countWithBadEncode('hello');
      expect.fail('expected CONTEXT_ACCOUNTING_UNAVAILABLE');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_unavailable');
    }
  });
});
