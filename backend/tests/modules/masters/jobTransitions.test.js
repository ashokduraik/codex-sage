/**
 * Unit tests for allowed jobStatus transitions.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';
import {
  ALLOWED_JOB_TRANSITIONS,
  assertJobTransition,
  isAllowedJobTransition,
} from '../../../src/modules/masters/jobs.js';
import { JOB_STATUS_VALUES } from '../../../src/modules/masters/jobs.helper.js';

describe('jobTransitions', () => {
  it('accepts every allowed pair from the matrix', () => {
    for (const [from, tos] of Object.entries(ALLOWED_JOB_TRANSITIONS)) {
      for (const to of tos) {
        expect(isAllowedJobTransition(from, to)).toBe(true);
        expect(() => assertJobTransition(from, to)).not.toThrow();
      }
    }
  });

  it('rejects terminal and unknown pairs with INVALID_JOB_TRANSITION', () => {
    expect(isAllowedJobTransition('completed', 'pending')).toBe(false);
    expect(isAllowedJobTransition('completed_with_warnings', 'retrying')).toBe(false);
    expect(isAllowedJobTransition('failed', 'running')).toBe(false);
    expect(isAllowedJobTransition('pending', 'failed')).toBe(false);

    try {
      assertJobTransition('completed', 'retrying');
      expect.fail('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe('INVALID_JOB_TRANSITION');
      expect(error.details).toEqual({
        currentStatus: 'completed',
        attemptedStatus: 'retrying',
      });
    }
  });

  it('covers every known jobStatus in the transition table', () => {
    for (const status of JOB_STATUS_VALUES) {
      expect(ALLOWED_JOB_TRANSITIONS).toHaveProperty(status);
    }
  });
});
