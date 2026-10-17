/**
 * Unit tests for job / stage visual mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  mapJobStatus,
  mapStageState,
  stageLabelKey,
  jobTypeLabelKey,
  selectActiveJob,
  isActiveJobStatus,
  jobStatusLabelKey,
  isHistoryJobStatus,
  hasRenderablePercent,
} from '@/features/projects/processing/jobProgressMap.js';

describe('jobProgressMap', () => {
  it('maps completed / failed / pending stage icons and falls back safely', () => {
    expect(mapStageState('completed').tone).toBe('success');
    expect(mapStageState('failed').tone).toBe('danger');
    expect(mapStageState('pending').tone).toBe('neutral');
    expect(mapStageState('current').spin).toBe(true);
    expect(mapStageState('unknown').tone).toBe('neutral');
    expect(mapStageState(null).tone).toBe('neutral');
  });

  it('maps jobStatus glyphs including completed_with_warnings', () => {
    expect(mapJobStatus('completed').tone).toBe('success');
    expect(mapJobStatus('completed_with_warnings').tone).toBe('attention');
    expect(mapJobStatus('failed').tone).toBe('danger');
    expect(mapJobStatus('mystery').tone).toBe('neutral');
  });

  it('classifies active and history statuses', () => {
    expect(isActiveJobStatus('running')).toBe(true);
    expect(isActiveJobStatus('pending')).toBe(true);
    expect(isActiveJobStatus('retrying')).toBe(true);
    expect(isActiveJobStatus('failed')).toBe(false);
    expect(isHistoryJobStatus('failed')).toBe(true);
    expect(isHistoryJobStatus('completed_with_warnings')).toBe(true);
    expect(isHistoryJobStatus('running')).toBe(false);
  });

  it('selects running over pending, then oldest pending', () => {
    expect(selectActiveJob([])).toBeNull();
    expect(
      selectActiveJob([
        { id: 'p1', jobStatus: 'pending', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'r1', jobStatus: 'running', createdAt: '2026-01-03T00:00:00.000Z' },
      ]).id,
    ).toBe('r1');
    expect(
      selectActiveJob([
        { id: 'new', jobStatus: 'pending', createdAt: '2026-01-03T00:00:00.000Z' },
        { id: 'old', jobStatus: 'pending', createdAt: '2026-01-01T00:00:00.000Z' },
      ]).id,
    ).toBe('old');
  });

  it('does not treat null percent as renderable', () => {
    expect(hasRenderablePercent(null)).toBe(false);
    expect(hasRenderablePercent(undefined)).toBe(false);
    expect(hasRenderablePercent(42)).toBe(true);
    expect(hasRenderablePercent(Number.NaN)).toBe(false);
  });

  it('builds i18n keys with unknown fallbacks', () => {
    expect(jobTypeLabelKey('project_knowledge_build')).toBe('processing.jobType.project_knowledge_build');
    expect(jobTypeLabelKey('')).toBe('processing.jobType.unknown');
    expect(stageLabelKey('validate_upload')).toBe('processing.stage.validate_upload');
    expect(stageLabelKey(null)).toBe('processing.stage.unknown');
    expect(jobStatusLabelKey('failed')).toBe('processing.jobStatus.failed');
    expect(jobStatusLabelKey()).toBe('processing.jobStatus.unknown');
  });
});
