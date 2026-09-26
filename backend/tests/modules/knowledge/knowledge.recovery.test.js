/**
 * Unit tests for same-job CodeGraph recovery.
 */
import { describe, expect, it, vi } from 'vitest';
import { isRecoverableCodegraphFailure, runCodegraphUpdateWithRecovery } from '../../../src/modules/knowledge/knowledge.js';
import { createJobFailureError } from '../../../src/worker/retryPolicy.js';

describe('knowledge.recovery', () => {
  it('classifies temporary CODEGRAPH_ failures as recoverable', () => {
    expect(
      isRecoverableCodegraphFailure(
        createJobFailureError({
          failureClass: 'temporary',
          code: 'CODEGRAPH_VALIDATION_FAILED',
          message: 'x',
        }),
      ),
    ).toBe(true);
    expect(
      isRecoverableCodegraphFailure(
        createJobFailureError({
          failureClass: 'permanent',
          code: 'CODEGRAPH_VALIDATION_FAILED',
          message: 'x',
        }),
      ),
    ).toBe(false);
  });

  it('calls S3 then S4 after a recoverable S4 failure and stops at max attempts', async () => {
    const runS3 = vi.fn().mockResolvedValue({ outcome: 'completed' });
    const wipeIndex = vi.fn().mockResolvedValue(undefined);
    const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
    const runS4 = vi
      .fn()
      .mockRejectedValueOnce(
        createJobFailureError({
          failureClass: 'temporary',
          code: 'CODEGRAPH_VALIDATION_FAILED',
          message: 'bad',
        }),
      )
      .mockResolvedValueOnce({
        outcome: 'completed',
        cursor: { graphIdentity: { graphHash: 'h' } },
      });

    const ctx = {
      checkpoint: { lastCompletedStage: 'materialize_docs', cursor: {} },
      carry: { workspacePath: '/tmp/ws' },
      saveCheckpoint,
      logger: { warn: vi.fn() },
    };

    const result = await runCodegraphUpdateWithRecovery(ctx, {
      runS3,
      runS4,
      wipeIndex,
      maxAttempts: 3,
    });

    expect(runS3).toHaveBeenCalledOnce();
    expect(wipeIndex).toHaveBeenCalledWith('/tmp/ws');
    expect(runS4).toHaveBeenCalledTimes(2);
    expect(result.cursor.graphIdentity.graphHash).toBe('h');
    expect(saveCheckpoint).toHaveBeenCalled();
  });

  it('throws CODEGRAPH_RECOVERY_EXHAUSTED when attempts are used up', async () => {
    const runS4 = vi.fn().mockRejectedValue(
      createJobFailureError({
        failureClass: 'temporary',
        code: 'CODEGRAPH_SQLITE_BUSY',
        message: 'busy',
      }),
    );

    await expect(
      runCodegraphUpdateWithRecovery(
        {
          checkpoint: { lastCompletedStage: 'materialize_docs', cursor: { recoveryAttempts: 3 } },
          carry: {},
          saveCheckpoint: vi.fn(),
          logger: { warn: vi.fn() },
        },
        { runS4, runS3: vi.fn(), wipeIndex: vi.fn(), maxAttempts: 3 },
      ),
    ).rejects.toMatchObject({
      code: 'CODEGRAPH_RECOVERY_EXHAUSTED',
      failureClass: 'permanent',
    });
  });
});
