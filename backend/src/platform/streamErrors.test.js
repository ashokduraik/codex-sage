import { describe, it, expect } from 'vitest';
import { ApiError } from './errors.js';
import { buildStreamErrorEvent } from './streamErrors.js';

describe('buildStreamErrorEvent', () => {
  it('returns the error event with all five fields', () => {
    const err = ApiError.fromCode('KNOWLEDGE_UNAVAILABLE');
    const frame = buildStreamErrorEvent(err, 'REQ-abc');
    expect(frame).toEqual({
      event: 'error',
      data: {
        code: 'KNOWLEDGE_UNAVAILABLE',
        class: 'knowledge',
        retryability: 'temporary',
        message: 'Project knowledge is not available.',
        reference: 'REQ-abc',
      },
    });
  });

  it('includes allowlisted details and drops them for other codes', () => {
    const withDetails = buildStreamErrorEvent(
      ApiError.fromCode('VALIDATION_ERROR', { details: { field: 'email' } }),
      'REQ-1',
    );
    expect(withDetails.data.details).toEqual({ field: 'email' });

    const without = buildStreamErrorEvent(
      ApiError.fromCode('NOT_FOUND', { details: { path: '/x' } }),
      'REQ-2',
    );
    expect(without.data.details).toBeUndefined();
  });

  it('maps unknown codes to INTERNAL_ERROR', () => {
    const frame = buildStreamErrorEvent(
      { code: 'MADE_UP', message: 'nope' },
      'REQ-z',
    );
    expect(frame.data.code).toBe('INTERNAL_ERROR');
    expect(frame.data.class).toBe('system');
    expect(frame.data.message).toBe('Internal server error');
  });

  it('defaults when error has no code and uses client message for 4xx', () => {
    const missing = buildStreamErrorEvent({}, 'REQ-m');
    expect(missing.data.code).toBe('INTERNAL_ERROR');
    expect(missing.data.message).toBe('Internal server error');

    const validation = buildStreamErrorEvent(
      { code: 'VALIDATION_ERROR', message: 'field email is required' },
      'REQ-v',
    );
    expect(validation.data.message).toBe('field email is required');
    expect(validation.data.class).toBe('user');

    const bare = buildStreamErrorEvent({ code: 'NOT_FOUND' }, 'REQ-n');
    expect(bare.data.message).toBe('Route not found.');
  });
});
