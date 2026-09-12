/**
 * Unit tests for derived job progress projection.
 */
import { describe, expect, it } from 'vitest';
import { deriveKnowledgeAvailability, projectJobProgress } from './jobProgress.js';

describe('jobProgress', () => {
  const baseJob = {
    jobType: 'ingest',
    jobStatus: 'failed',
    currentStage: 'materialize_docs',
    stageCheckpoint: { lastCompletedStage: 'exclude_apply' },
    progressCounters: {
      itemsProcessed: 4812,
      itemsFailed: 9,
      warningCount: 2,
      excludedCount: 0,
    },
    startedAt: new Date('2026-09-11T10:42:00.000Z'),
    completedAt: new Date('2026-09-11T10:47:12.000Z'),
    cancelRequestedAt: null,
    failureClass: 'temporary',
    retryCount: 0,
  };

  it('marks exactly one current stage and leaves later stages pending', () => {
    const progress = projectJobProgress({
      ...baseJob,
      jobStatus: 'running',
      completedAt: null,
    });
    const currents = progress.stages.filter((stage) => stage.state === 'current');
    expect(currents).toHaveLength(1);
    expect(currents[0].stage).toBe('materialize_docs');
    expect(progress.stages.find((stage) => stage.stage === 'codegraph_update')?.state).toBe(
      'pending',
    );
    expect(progress.stages[0].state).toBe('completed');
  });

  it('orders stages canonically and marks the failed stage', () => {
    const progress = projectJobProgress(baseJob);
    expect(progress.stages.map((stage) => stage.stage)).toEqual([
      'validate_upload',
      'store_files',
      'exclude_apply',
      'materialize_docs',
      'codegraph_update',
      'knowledge_publish',
      'finalize',
    ]);
    expect(progress.stages.find((stage) => stage.stage === 'materialize_docs')?.state).toBe(
      'failed',
    );
    expect(progress.itemsProcessed).toBe(4812);
    expect(progress.itemsFailed).toBe(9);
    expect(progress.durationMs).toBe(312000);
  });

  it('leaves percent null without a real total and computes when total exists', () => {
    expect(projectJobProgress(baseJob).percent).toBeNull();
    expect(
      projectJobProgress({
        ...baseJob,
        progressCounters: { ...baseJob.progressCounters, itemsTotal: 5000 },
      }).percent,
    ).toBe(96);
  });

  it('returns all-pending stages when there are zero events and no progress', () => {
    const progress = projectJobProgress({
      jobType: 'ingest',
      jobStatus: 'pending',
      currentStage: null,
      stageCheckpoint: null,
      progressCounters: {
        itemsProcessed: 0,
        itemsFailed: 0,
        warningCount: 0,
        excludedCount: 0,
      },
      startedAt: null,
      completedAt: null,
      cancelRequestedAt: null,
      retryCount: 0,
    });
    expect(progress.stages.every((stage) => stage.state === 'current' || stage.state === 'pending')).toBe(
      true,
    );
    expect(progress.stages.filter((stage) => stage.state === 'current')).toHaveLength(1);
    expect(progress.warnings).toEqual([]);
    expect(progress.errors).toEqual([]);
    expect(progress.knowledgeAvailability).toBe('queued');
  });

  it('aggregates warning and error event summaries', () => {
    const progress = projectJobProgress(baseJob, [
      {
        eventCode: 'FILE_OVER_GRAPH_SIZE_LIMIT',
        severity: 'warning',
        message: '3 files are too large to analyze.',
        data: { affectedCount: 3 },
        createdAt: new Date('2026-09-11T10:43:02.000Z'),
      },
      {
        eventCode: 'DOCUMENT_PARSE_FAILED',
        severity: 'error',
        message: '9 documentation files could not be analyzed.',
        data: { affectedCount: 9 },
        createdAt: new Date('2026-09-11T10:47:12.000Z'),
      },
    ]);
    expect(progress.warnings).toHaveLength(1);
    expect(progress.errors[0].affectedCount).toBe(9);
    expect(progress.retry.available).toBe(true);
    expect(progress.retry.mode).toBe('resume');
  });

  it('derives knowledgeAvailability from job status', () => {
    expect(deriveKnowledgeAvailability('completed')).toBe('available');
    expect(deriveKnowledgeAvailability('pending')).toBe('queued');
    expect(deriveKnowledgeAvailability('failed')).toBe('paused');
  });

  it('projects completed, cancelled, and per-stage counters', () => {
    const completed = projectJobProgress({
      ...baseJob,
      jobStatus: 'completed',
      currentStage: 'finalize',
      stageCheckpoint: { lastCompletedStage: 'finalize' },
    });
    expect(completed.stages.every((stage) => stage.state === 'completed')).toBe(true);
    expect(completed.knowledgeAvailability).toBe('available');

    const cancelled = projectJobProgress({
      ...baseJob,
      jobStatus: 'cancelled',
      currentStage: 'materialize_docs',
      cancelRequestedAt: new Date('2026-09-11T10:44:01.000Z'),
    });
    expect(cancelled.stages.find((stage) => stage.stage === 'materialize_docs')?.state).toBe(
      'failed',
    );
    expect(cancelled.cancellation.requested).toBe(true);

    const withPerStage = projectJobProgress({
      ...baseJob,
      jobStatus: 'running',
      completedAt: null,
      progressByStage: {
        materialize_docs: { itemsProcessed: 12, itemsFailed: 1, warningCount: 2 },
      },
    });
    expect(
      withPerStage.stages.find((stage) => stage.stage === 'materialize_docs')?.itemsProcessed,
    ).toBe(12);
  });
});
