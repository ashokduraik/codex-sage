/**
 * Unit tests for same-job CodeGraph recovery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobFailureError } from '../../../src/worker/retryPolicy.js';

const { runMaterializeDocsStage, runCodegraphUpdateStage, fsRm, fsMkdir } = vi.hoisted(() => ({
  runMaterializeDocsStage: vi.fn(),
  runCodegraphUpdateStage: vi.fn(),
  fsRm: vi.fn(),
  fsMkdir: vi.fn(),
}));

vi.mock('../../../src/modules/knowledge/ingest.util.js', () => ({
  runMaterializeDocsStage,
  runCodegraphUpdateStage,
}));

vi.mock('node:fs/promises', () => ({
  default: {
    rm: (...args) => fsRm(...args),
    mkdir: (...args) => fsMkdir(...args),
  },
  rm: (...args) => fsRm(...args),
  mkdir: (...args) => fsMkdir(...args),
}));

import { isRecoverableCodegraphFailure, runCodegraphUpdateWithRecovery } from '../../../src/modules/knowledge/knowledge.js';

describe('knowledge.recovery', () => {
  beforeEach(() => {
    runMaterializeDocsStage.mockReset();
    runCodegraphUpdateStage.mockReset();
    fsRm.mockReset().mockResolvedValue(undefined);
    fsMkdir.mockReset().mockResolvedValue(undefined);
  });

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
    runMaterializeDocsStage.mockResolvedValue({ outcome: 'completed' });
    runCodegraphUpdateStage
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

    const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      checkpoint: { lastCompletedStage: 'materialize_docs', cursor: {} },
      carry: { workspacePath: '/tmp/ws' },
      saveCheckpoint,
      logger: { warn: vi.fn() },
    };

    const result = await runCodegraphUpdateWithRecovery(ctx);

    expect(runMaterializeDocsStage).toHaveBeenCalledOnce();
    expect(fsRm).toHaveBeenCalled();
    expect(runCodegraphUpdateStage).toHaveBeenCalledTimes(2);
    expect(result.cursor.graphIdentity.graphHash).toBe('h');
    expect(saveCheckpoint).toHaveBeenCalled();
  });

  it('throws CODEGRAPH_RECOVERY_EXHAUSTED when attempts are used up', async () => {
    runCodegraphUpdateStage.mockRejectedValue(
      createJobFailureError({
        failureClass: 'temporary',
        code: 'CODEGRAPH_SQLITE_BUSY',
        message: 'busy',
      }),
    );

    await expect(
      runCodegraphUpdateWithRecovery({
        checkpoint: { lastCompletedStage: 'materialize_docs', cursor: { recoveryAttempts: 3 } },
        carry: {},
        saveCheckpoint: vi.fn(),
        logger: { warn: vi.fn() },
      }),
    ).rejects.toMatchObject({
      code: 'CODEGRAPH_RECOVERY_EXHAUSTED',
      failureClass: 'permanent',
    });
  });
});
