/**
 * Unit tests for ingest stage list resume and placeholders.
 */
import { describe, expect, it } from 'vitest';
import { createJobFailureError } from '../../worker/retryPolicy.js';
import { INGEST_STAGES, resolveStagesAfter } from './ingest.stages.js';

describe('resolveStagesAfter', () => {
  it('returns the full list when there is no checkpoint', () => {
    expect(resolveStagesAfter(null).map((s) => s.name)).toEqual(
      INGEST_STAGES.map((s) => s.name),
    );
    expect(resolveStagesAfter(undefined).map((s) => s.name)).toEqual(
      INGEST_STAGES.map((s) => s.name),
    );
  });

  it('resumes after lastCompletedStage', () => {
    expect(resolveStagesAfter('validate_upload').map((s) => s.name)).toEqual([
      'store_files',
      'exclude_apply',
      'materialize_docs',
      'codegraph_update',
      'knowledge_publish',
      'finalize',
    ]);
    expect(resolveStagesAfter('exclude_apply').map((s) => s.name)[0]).toBe('materialize_docs');
  });

  it('fails loudly for an unknown checkpoint stage', () => {
    expect(() => resolveStagesAfter('not_a_real_stage')).toThrow(
      expect.objectContaining({
        code: 'INGEST_UNKNOWN_CHECKPOINT_STAGE',
        failureClass: 'permanent',
      }),
    );
  });

  it('placeholder stages throw NOT_IMPLEMENTED as permanent', async () => {
    const publish = INGEST_STAGES.find((s) => s.name === 'knowledge_publish');
    await expect(publish.run({})).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      failureClass: 'permanent',
    });
  });

  it('wires materialize_docs and codegraph_update to real stage runners', () => {
    const materialize = INGEST_STAGES.find((s) => s.name === 'materialize_docs');
    expect(materialize).toBeDefined();
    expect(typeof materialize.run).toBe('function');
    const codegraph = INGEST_STAGES.find((s) => s.name === 'codegraph_update');
    expect(codegraph).toBeDefined();
    expect(typeof codegraph.run).toBe('function');
  });
});

describe('createJobFailureError shape', () => {
  it('never returns a bare Error without code and failureClass', () => {
    const error = createJobFailureError({
      failureClass: 'temporary',
      code: 'INGEST_STAGE_TIMEOUT',
      message: 'timed out',
    });
    expect(error.code).toBe('INGEST_STAGE_TIMEOUT');
    expect(error.failureClass).toBe('temporary');
  });
});
