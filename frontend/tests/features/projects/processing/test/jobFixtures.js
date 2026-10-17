/**
 * Shared job fixtures for processing UI tests.
 */

/**
 * @param {object} [overrides] Field overrides.
 * @returns {object}
 */
export function buildListJob(overrides = {}) {
  return {
    id: 'job_active',
    jobType: 'project_knowledge_build',
    jobStatus: 'running',
    currentStage: 'codegraph_update',
    failureClass: null,
    partialSuccess: false,
    progressCounters: {
      itemsProcessed: 10,
      itemsFailed: 0,
      warningCount: 0,
      excludedCount: 0,
    },
    scheduledAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-02T00:00:00.000Z',
    startedAt: '2026-01-02T00:01:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

/**
 * @param {object} [overrides] Field overrides.
 * @returns {object}
 */
export function buildJobDetail(overrides = {}) {
  const list = buildListJob(overrides);
  return {
    ...list,
    projectId: 'prj_atlas',
    sourceVersionId: 'sv1',
    stageCheckpoint: null,
    correlationId: 'corr-1',
    events: [
      {
        eventCode: 'job.enqueued',
        severity: 'info',
        message: 'Processing is queued.',
        data: {},
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    durationMs: null,
    percent: null,
    itemsProcessed: 10,
    itemsFailed: 0,
    stages: [
      { stage: 'validate_upload', label: 'Source received', state: 'completed' },
      { stage: 'codegraph_update', label: 'Project structure analyzed', state: 'current' },
      { stage: 'finalize', label: 'Processing finalized', state: 'pending' },
    ],
    warnings: [],
    errors: [],
    retry: { available: false, mode: null, reason: null },
    cancellation: { requested: false, requestedAt: null },
    knowledgeAvailability: 'paused',
    ...overrides,
  };
}
