/**
 * Unit tests for job DTO mappers.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { mapJobToDetailDto, mapJobToListDto, mapJobEventToDto } from '../../../src/modules/masters/jobs.js';

describe('jobs.types', () => {
  const jobId = new mongoose.Types.ObjectId();
  const projectId = new mongoose.Types.ObjectId();
  const sourceVersionId = new mongoose.Types.ObjectId();
  const createdAt = new Date('2026-09-11T10:40:00.000Z');

  const jobDoc = {
    _id: jobId,
    projectId,
    jobType: 'ingest',
    jobStatus: 'pending',
    currentStage: null,
    failureClass: null,
    partialSuccess: false,
    progressCounters: {
      itemsProcessed: 0,
      itemsFailed: 0,
      warningCount: 0,
      excludedCount: 0,
    },
    scheduledAt: createdAt,
    createdAt,
    startedAt: null,
    completedAt: null,
    sourceVersionId,
    stageCheckpoint: {
      lastCompletedStage: 'exclude_apply',
      cursor: { offset: 3 },
      updatedAt: createdAt,
    },
    correlationId: 'req_01J9ZK4T2M',
    workerId: 'worker-should-not-leak',
  };

  it('maps list DTO without workerId or stageCheckpoint', () => {
    const dto = mapJobToListDto(jobDoc);
    expect(dto.id).toBe(String(jobId));
    expect(dto.jobType).toBe('ingest');
    expect(dto.jobStatus).toBe('pending');
    expect(dto.progressCounters.itemsProcessed).toBe(0);
    expect(dto).not.toHaveProperty('workerId');
    expect(dto).not.toHaveProperty('stageCheckpoint');
    expect(dto).not.toHaveProperty('events');
    expect(dto).not.toHaveProperty('correlationId');
  });

  it('maps detail DTO with stageCheckpoint and events, omitting workerId', () => {
    const events = [
      {
        eventCode: 'job.enqueued',
        severity: 'info',
        message: 'Processing is queued.',
        data: {},
        createdAt,
      },
    ];
    const dto = mapJobToDetailDto(jobDoc, events);
    expect(dto.projectId).toBe(String(projectId));
    expect(dto.sourceVersionId).toBe(String(sourceVersionId));
    expect(dto.correlationId).toBe('req_01J9ZK4T2M');
    expect(dto.stageCheckpoint).toEqual({
      lastCompletedStage: 'exclude_apply',
      cursor: { offset: 3 },
      updatedAt: createdAt.toISOString(),
    });
    expect(dto.events).toHaveLength(1);
    expect(dto.events[0].eventCode).toBe('job.enqueued');
    expect(dto).not.toHaveProperty('workerId');
    expect(dto.stages).toEqual(expect.any(Array));
    expect(dto.stages.length).toBeGreaterThan(0);
    expect(dto).toHaveProperty('percent');
    expect(dto).toHaveProperty('retry');
    expect(dto).toHaveProperty('cancellation');
    expect(dto).toHaveProperty('knowledgeAvailability');
  });

  it('maps string dates and empty counters on list DTO', () => {
    const dto = mapJobToListDto({
      _id: jobId,
      jobType: 'ingest',
      jobStatus: 'failed',
      currentStage: 's1',
      failureClass: 'temporary',
      partialSuccess: true,
      progressCounters: null,
      scheduledAt: '2026-09-11T10:40:00.000Z',
      createdAt: '',
      startedAt: undefined,
      completedAt: createdAt,
    });
    expect(dto.scheduledAt).toBe('2026-09-11T10:40:00.000Z');
    expect(dto.createdAt).toBeNull();
    expect(dto.startedAt).toBeNull();
    expect(dto.completedAt).toBe(createdAt.toISOString());
    expect(dto.progressCounters).toEqual({
      itemsProcessed: 0,
      itemsFailed: 0,
      warningCount: 0,
      excludedCount: 0,
    });
  });

  it('maps null stageCheckpoint and empty event data', () => {
    const dto = mapJobToDetailDto({ ...jobDoc, stageCheckpoint: null, sourceVersionId: null }, [
      { eventCode: 'x', severity: 'info', message: 'm', data: null, createdAt },
    ]);
    expect(dto.stageCheckpoint).toBeNull();
    expect(dto.sourceVersionId).toBeNull();
    expect(
      mapJobEventToDto({
        eventCode: 'x',
        severity: 'info',
        message: 'm',
        data: null,
        createdAt,
      }).data,
    ).toEqual({});
  });
});
