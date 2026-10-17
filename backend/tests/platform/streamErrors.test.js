/**
 * Unit tests for SSE terminal error frame builder.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/platform/errors.js';
import { buildStreamErrorEvent } from '../../src/platform/streamErrors.js';

describe('buildStreamErrorEvent', () => {
  it('maps ApiError to the five-field SSE error data object', () => {
    const frame = buildStreamErrorEvent(ApiError.fromCode('KNOWLEDGE_UNAVAILABLE'), 'REQ-abc');
    expect(frame.event).toBe('error');
    expect(frame.data).toEqual({
      code: 'KNOWLEDGE_UNAVAILABLE',
      class: 'knowledge',
      retryability: 'temporary',
      message: 'Project knowledge is not available.',
      reference: 'REQ-abc',
    });
    expect(JSON.stringify(frame.data)).not.toMatch(/chain.of.thought|thinking|reasoning/i);
  });

  it('uses unknown reference when correlation id is empty', () => {
    const frame = buildStreamErrorEvent(ApiError.fromCode('VALIDATION_ERROR'), '');
    expect(frame.data.reference).toBe('unknown');
  });

  it('maps unexpected throws to INTERNAL_ERROR without leaking stacks in data', () => {
    const frame = buildStreamErrorEvent(new Error('provider boom'), 'REQ-1');
    expect(frame.data.code).toBe('INTERNAL_ERROR');
    expect(frame.data.reference).toBe('REQ-1');
    expect(JSON.stringify(frame.data)).not.toContain('provider boom');
  });
});
