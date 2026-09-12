/**
 * Unit tests for job control route param parsing.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../platform/errors.js';
import { parseJobControlParams, zodDetails } from './jobControl.params.js';
import { z } from 'zod';

describe('jobControl.params', () => {
  it('accepts a non-empty jobId', () => {
    expect(parseJobControlParams({ jobId: '665f1c9d4b2a8e0012a4f001' })).toEqual({
      jobId: '665f1c9d4b2a8e0012a4f001',
    });
  });

  it('rejects missing or empty jobId', () => {
    expect(() => parseJobControlParams({})).toThrow(ApiError);
    expect(() => parseJobControlParams({ jobId: '' })).toThrow(ApiError);
    try {
      parseJobControlParams(null);
      expect.fail('expected throw');
    } catch (error) {
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details[0].path).toBe('jobId');
    }
  });

  it('maps zod issues with an empty path to params', () => {
    const schema = z.string().min(1);
    const result = schema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(zodDetails(result.error)[0].path).toBe('params');
    }
  });
});
