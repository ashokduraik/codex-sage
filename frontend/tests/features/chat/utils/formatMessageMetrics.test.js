/**
 * Unit tests for metric formatting helpers.
 */
import { describe, expect, it } from 'vitest';
import { formatMessageMetrics, shortenKnowledgeVersionId } from '@/features/chat/utils/formatMessageMetrics.js';

describe('formatMessageMetrics', () => {
  it('returns null when nothing is present', () => {
    expect(formatMessageMetrics(null)).toBeNull();
    expect(formatMessageMetrics({})).toBeNull();
    expect(formatMessageMetrics({ usage: {} })).toBeNull();
  });

  it('includes only defined numeric fields and never invents zeros for missing ones', () => {
    expect(
      formatMessageMetrics({
        durationMs: 2800,
        usage: { inputTokens: 100, outputTokens: undefined, totalTokens: null },
      }),
    ).toEqual({ durationMs: 2800, inputTokens: 100 });
  });

  it('rejects negative or non-finite values', () => {
    expect(formatMessageMetrics({ durationMs: -1, usage: { inputTokens: Number.NaN } })).toBeNull();
  });
});

describe('shortenKnowledgeVersionId', () => {
  it('returns empty for missing ids and shortens long ones', () => {
    expect(shortenKnowledgeVersionId(null)).toBe('');
    expect(shortenKnowledgeVersionId('abc')).toBe('abc');
    expect(shortenKnowledgeVersionId('6650abcdef12')).toBe('6650abcd');
  });
});
