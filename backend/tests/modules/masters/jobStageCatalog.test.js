/**
 * Unit tests for job stage catalogue helpers.
 */
import { describe, expect, it } from 'vitest';
import { labelForJobStage, listStagesForJobType } from '../../../src/modules/masters/jobs.helper.js';

describe('jobStageCatalog', () => {
  it('lists ingest stages and labels', () => {
    const stages = listStagesForJobType('project_knowledge_build');
    expect(stages[0]).toEqual({ stage: 'validate_upload', label: 'Source received' });
    expect(labelForJobStage('project_knowledge_build', 'materialize_docs')).toBe('Documentation analyzed');
  });

  it('lists connected_repo_pull stages separately from knowledge build', () => {
    const stages = listStagesForJobType('connected_repo_pull');
    expect(stages.map((entry) => entry.stage)).toEqual(['fetch_remote', 'persist_source', 'enqueue_ingest']);
    expect(labelForJobStage('connected_repo_pull', 'fetch_remote')).toBe('Checking repository');
  });

  it('lists aged_org_data_cleanup as a single apply_policy stage', () => {
    expect(listStagesForJobType('aged_org_data_cleanup')).toEqual([{ stage: 'apply_policy', label: 'Applying retention' }]);
    expect(labelForJobStage('aged_org_data_cleanup', 'apply_policy')).toBe('Applying retention');
  });

  it('falls back for unknown types and stages', () => {
    expect(listStagesForJobType('unknown_type')).toEqual([]);
    expect(labelForJobStage('project_knowledge_build', 'no_such_stage')).toBe('no_such_stage');
  });
});
