import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/platform/errors.js';
import { WORKER_RETRY_BACKOFF_BASE_MS, WORKER_RETRY_BACKOFF_MAX_MS } from '../../src/worker/worker.constants.js';
import {
  decideFailureOutcome,
  classifyThrownFailure,
  computeRetryBackoffMs,
  createJobFailureError,
  createJobFailureFromCaught,
} from '../../src/worker/retryPolicy.js';

describe('retryPolicy', () => {
  it('maps each failure class to requeue or fail', () => {
    expect(
      decideFailureOutcome({
        failure: { failureClass: 'temporary', code: 'T', message: 't' },
        attempt: 1,
        maxAttempts: 5,
      }).action,
    ).toBe('requeue');

    expect(
      decideFailureOutcome({
        failure: { failureClass: 'permanent', code: 'P', message: 'p' },
        attempt: 1,
        maxAttempts: 5,
      }).action,
    ).toBe('fail');

    expect(
      decideFailureOutcome({
        failure: { failureClass: 'user_action_required', code: 'U', message: 'u' },
        attempt: 1,
        maxAttempts: 5,
      }).action,
    ).toBe('fail');

    expect(
      decideFailureOutcome({
        failure: { failureClass: 'temporary', code: 'T', message: 't' },
        attempt: 5,
        maxAttempts: 5,
      }).action,
    ).toBe('fail');
  });

  it('treats an unclassified error as temporary', () => {
    const classified = classifyThrownFailure(new Error('boom'));
    expect(classified).toEqual({
      failureClass: 'temporary',
      code: 'WORKER_UNCLASSIFIED_ERROR',
      message: 'boom',
      unclassified: true,
    });
  });

  it('maps catalog ApiError retryability so empty-after-exclusions fails immediately', () => {
    const err = ApiError.fromCode('SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS');
    expect(classifyThrownFailure(err)).toEqual({
      failureClass: 'user_action_required',
      code: 'SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS',
      message: err.message,
      unclassified: false,
    });
  });

  it('reads classification from createJobFailureError', () => {
    const err = createJobFailureError({
      failureClass: 'permanent',
      code: 'BAD',
      message: 'nope',
    });
    expect(classifyThrownFailure(err)).toMatchObject({
      failureClass: 'permanent',
      code: 'BAD',
      unclassified: false,
    });
  });

  it('createJobFailureFromCaught logs the original and attaches cause', () => {
    const log = { error: vi.fn() };
    const cause = new Error('disk full');
    const err = createJobFailureFromCaught(
      {
        failureClass: 'temporary',
        code: 'WORKSPACE_IO_ERROR',
        message: 'volume unavailable',
      },
      cause,
      { log, logMessage: 'workspace volume IO failure' },
    );
    expect(err.cause).toBe(cause);
    expect(err.code).toBe('WORKSPACE_IO_ERROR');
    expect(log.error).toHaveBeenCalledWith(
      {
        errName: 'Error',
        errMessage: 'disk full',
        errStack: cause.stack,
      },
      'workspace volume IO failure',
    );
  });

  it('grows backoff exponentially, respects the ceiling, and stays positive with jitter', () => {
    const noJitter = () => 0;
    expect(computeRetryBackoffMs(1, { random: noJitter })).toBe(WORKER_RETRY_BACKOFF_BASE_MS);
    expect(computeRetryBackoffMs(2, { random: noJitter })).toBe(WORKER_RETRY_BACKOFF_BASE_MS * 2);
    expect(computeRetryBackoffMs(20, { random: noJitter })).toBe(WORKER_RETRY_BACKOFF_MAX_MS);

    const withJitter = computeRetryBackoffMs(1, { random: () => 0.5 });
    expect(withJitter).toBeGreaterThan(WORKER_RETRY_BACKOFF_BASE_MS);
    expect(withJitter).toBeGreaterThan(0);
  });

  it('covers unclassified non-error throws and default maxAttempts', () => {
    expect(classifyThrownFailure('plain')).toMatchObject({
      failureClass: 'temporary',
      unclassified: true,
    });
    expect(classifyThrownFailure({ failureClass: 'nope', code: 'X' })).toMatchObject({ failureClass: 'temporary', unclassified: true });
    expect(
      decideFailureOutcome({
        failure: { failureClass: 'temporary', code: 'T', message: 't' },
        attempt: 1,
      }).action,
    ).toBe('requeue');
  });
});
