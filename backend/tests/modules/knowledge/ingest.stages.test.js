/**
 * Unit tests for ingest stage list resume.
 */
import { describe, expect, it } from 'vitest';
import { createJobFailureError } from '../../../src/worker/jobFailure.js';
import { INGEST_STAGES, resolveStagesAfter } from '../../../src/modules/knowledge/ingest.js';

describe('resolveStagesAfter', () => {
  it('returns the full list when there is no checkpoint', () => {
    expect(resolveStagesAfter(null).map((s) => s.name)).toEqual(INGEST_STAGES.map((s) => s.name));
    expect(resolveStagesAfter(undefined).map((s) => s.name)).toEqual(INGEST_STAGES.map((s) => s.name));
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

  it('wires S0–S6 stages to real runners including knowledge_publish and finalize', () => {
    for (const name of ['validate_upload', 'store_files', 'exclude_apply', 'materialize_docs', 'codegraph_update', 'knowledge_publish', 'finalize']) {
      const stage = INGEST_STAGES.find((s) => s.name === name);
      expect(stage).toBeDefined();
      expect(typeof stage.run).toBe('function');
    }
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
