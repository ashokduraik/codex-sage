/**
 * Unit tests for job stage catalogue helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  labelForJobStage,
  listStagesForJobType,
} from './jobStageCatalog.js';

describe('jobStageCatalog', () => {
  it('lists ingest stages and labels', () => {
    const stages = listStagesForJobType('ingest');
    expect(stages[0]).toEqual({ stage: 'validate_upload', label: 'Source received' });
    expect(labelForJobStage('ingest', 'materialize_docs')).toBe('Documentation analyzed');
  });

  it('lists repo_sync stages separately from ingest', () => {
    const stages = listStagesForJobType('repo_sync');
    expect(stages.map((entry) => entry.stage)).toEqual([
      'fetch_remote',
      'persist_source',
      'enqueue_ingest',
    ]);
    expect(labelForJobStage('repo_sync', 'fetch_remote')).toBe('Checking repository');
  });

  it('falls back for unknown types and stages', () => {
    expect(listStagesForJobType('unknown_type')).toEqual([]);
    expect(labelForJobStage('ingest', 'no_such_stage')).toBe('no_such_stage');
  });
});
