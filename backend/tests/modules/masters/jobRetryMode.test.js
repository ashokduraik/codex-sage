/**
 * Unit tests for retry mode resolution.
 */
import { describe, expect, it } from 'vitest';
import { describeRetryAvailability, resolveJobRetryMode } from '../../../src/modules/masters/jobs.helper.js';

describe('jobRetryMode', () => {
  it('returns not_retryable for user_action_required on upload stages', () => {
    expect(
      resolveJobRetryMode({
        jobStatus: 'failed',
        failureClass: 'user_action_required',
        currentStage: 'validate_upload',
        stageCheckpoint: null,
      }),
    ).toMatchObject({ mode: 'not_retryable', fromStage: null });

    expect(
      resolveJobRetryMode({
        jobStatus: 'failed',
        failureClass: 'user_action_required',
        currentStage: 'store_files',
      }).mode,
    ).toBe('not_retryable');
  });

  it('returns full for graph-stage failures', () => {
    const resolved = resolveJobRetryMode({
      jobStatus: 'failed',
      failureClass: 'temporary',
      currentStage: 'codegraph_update',
      stageCheckpoint: { lastCompletedStage: 'materialize_docs' },
    });
    expect(resolved).toEqual({
      mode: 'full',
      fromStage: 'validate_upload',
      reason: expect.stringContaining('structure'),
    });
  });

  it('returns resume when a checkpoint exists on a resumable stage', () => {
    expect(
      resolveJobRetryMode({
        jobStatus: 'failed',
        failureClass: 'temporary',
        currentStage: 'materialize_docs',
        stageCheckpoint: { lastCompletedStage: 'exclude_apply' },
      }),
    ).toEqual({
      mode: 'resume',
      fromStage: 'materialize_docs',
      reason: null,
    });
  });

  it('returns full for permanent failures without a usable checkpoint', () => {
    expect(
      resolveJobRetryMode({
        jobStatus: 'failed',
        failureClass: 'permanent',
        currentStage: 'exclude_apply',
        stageCheckpoint: null,
      }).mode,
    ).toBe('full');
  });

  it('describes availability for detail payload', () => {
    expect(
      describeRetryAvailability(
        {
          jobStatus: 'completed',
          retryCount: 0,
        },
        10,
      ).available,
    ).toBe(false);

    expect(
      describeRetryAvailability(
        {
          jobStatus: 'failed',
          failureClass: 'user_action_required',
          currentStage: 'validate_upload',
          retryCount: 0,
        },
        10,
      ),
    ).toMatchObject({ available: false, mode: null });

    expect(
      describeRetryAvailability(
        {
          jobStatus: 'failed',
          failureClass: 'temporary',
          currentStage: 'materialize_docs',
          stageCheckpoint: { lastCompletedStage: 'exclude_apply' },
          retryCount: 10,
        },
        10,
      ).available,
    ).toBe(false);

    expect(
      describeRetryAvailability(
        {
          jobStatus: 'cancelled',
          failureClass: null,
          currentStage: null,
          stageCheckpoint: { lastCompletedStage: 'store_files' },
          retryCount: 1,
        },
        10,
      ),
    ).toMatchObject({ available: true, mode: 'resume' });
  });
});
