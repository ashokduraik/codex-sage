/**
 * Derived progress projection for job detail (never stored twice).
 */
import { listStagesForJobType } from './jobStageCatalog.js';
import { describeRetryAvailability } from './jobRetryMode.js';
import { JOB_MAX_USER_RETRIES } from './jobs.constants.js';

/**
 * Formats a date as ISO-8601, or null when missing.
 * @param {unknown} value Date or string.
 * @returns {string | null}
 */
function toIsoOrNull(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value == null || value === '') {
    return null;
  }
  return String(value);
}

/**
 * Derives knowledgeAvailability from job lifecycle until a knowledge module owns it.
 * @param {string} jobStatus Current job status.
 * @returns {'paused' | 'queued' | 'available'}
 */
export function deriveKnowledgeAvailability(jobStatus) {
  if (jobStatus === 'completed' || jobStatus === 'completed_with_warnings') {
    return 'available';
  }
  if (jobStatus === 'pending' || jobStatus === 'retrying') {
    return 'queued';
  }
  return 'paused';
}

/**
 * Resolves which stage index is current/failed for projection.
 * @param {readonly { stage: string }[]} definitions Stage list.
 * @param {object} job Job document.
 * @returns {{ currentIndex: number, lastCompletedIndex: number }}
 */
function resolveStageIndexes(definitions, job) {
  const lastCompletedIndex = definitions.findIndex(
    (entry) => entry.stage === (job.stageCheckpoint?.lastCompletedStage ?? null),
  );
  let currentIndex = definitions.findIndex((entry) => entry.stage === (job.currentStage ?? null));
  if (currentIndex < 0 && lastCompletedIndex >= 0 && lastCompletedIndex + 1 < definitions.length) {
    currentIndex = lastCompletedIndex + 1;
  }
  if (currentIndex < 0 && lastCompletedIndex < 0 && definitions.length > 0) {
    currentIndex = 0;
  }
  return { currentIndex, lastCompletedIndex };
}

/**
 * Builds per-stage progress rows from the job document.
 * @param {object} job Job document or lean object.
 * @returns {object[]}
 */
function projectStages(job) {
  const definitions = listStagesForJobType(job.jobType);
  const { currentIndex, lastCompletedIndex } = resolveStageIndexes(definitions, job);
  const isTerminalSuccess =
    job.jobStatus === 'completed' || job.jobStatus === 'completed_with_warnings';
  const isActive =
    job.jobStatus === 'running' ||
    job.jobStatus === 'pending' ||
    job.jobStatus === 'retrying';

  return definitions.map((definition, index) => {
    /** @type {'completed' | 'current' | 'pending' | 'failed' | 'skipped'} */
    let state = 'pending';
    if (isTerminalSuccess) {
      state = 'completed';
    } else if (job.jobStatus === 'failed' && index === currentIndex) {
      state = 'failed';
    } else if (job.jobStatus === 'failed' && lastCompletedIndex >= 0 && index <= lastCompletedIndex) {
      state = 'completed';
    } else if (job.jobStatus === 'cancelled' && index === currentIndex) {
      state = 'failed';
    } else if (
      job.jobStatus === 'cancelled' &&
      lastCompletedIndex >= 0 &&
      index <= lastCompletedIndex
    ) {
      state = 'completed';
    } else if (isActive && index === currentIndex) {
      state = 'current';
    } else if (lastCompletedIndex >= 0 && index <= lastCompletedIndex) {
      state = 'completed';
    }

    const perStage = job.progressByStage?.[definition.stage];
    const attachJobTotals =
      !job.progressByStage && (state === 'failed' || state === 'current');

    return {
      stage: definition.stage,
      label: definition.label,
      state,
      startedAt: toIsoOrNull(state === 'pending' ? null : job.startedAt),
      endedAt: toIsoOrNull(
        state === 'completed' || state === 'failed' ? job.completedAt : null,
      ),
      itemsProcessed: perStage
        ? (perStage.itemsProcessed ?? 0)
        : attachJobTotals
          ? (job.progressCounters?.itemsProcessed ?? 0)
          : 0,
      itemsFailed: perStage
        ? (perStage.itemsFailed ?? 0)
        : attachJobTotals && state === 'failed'
          ? (job.progressCounters?.itemsFailed ?? 0)
          : 0,
      warningCount: perStage ? (perStage.warningCount ?? 0) : 0,
    };
  });
}

/**
 * Collects warning/error summary rows from job events.
 * @param {object[]} events Job events.
 * @param {'warning' | 'error'} severity Severity filter.
 * @returns {{ code: string, message: string, affectedCount: number, occurredAt: string | null }[]}
 */
function collectSeveritySummaries(events, severity) {
  /** @type {Map<string, { code: string, message: string, affectedCount: number, occurredAt: string | null }>} */
  const byCode = new Map();
  for (const event of events) {
    if (event.severity !== severity) {
      continue;
    }
    const code = event.eventCode || event.data?.code || 'UNKNOWN';
    const affectedCount =
      typeof event.data?.affectedCount === 'number' ? event.data.affectedCount : 1;
    const existing = byCode.get(code);
    if (existing) {
      existing.affectedCount += affectedCount;
      existing.occurredAt = toIsoOrNull(event.createdAt) ?? existing.occurredAt;
    } else {
      byCode.set(code, {
        code,
        message: event.message,
        affectedCount,
        occurredAt: toIsoOrNull(event.createdAt),
      });
    }
  }
  return [...byCode.values()];
}

/**
 * Computes percent only when a real total is known; otherwise null (never fabricate).
 * @param {object} job Job document.
 * @returns {number | null}
 */
function computePercent(job) {
  const processed = job.progressCounters?.itemsProcessed;
  const total = job.progressCounters?.itemsTotal;
  if (
    typeof processed !== 'number' ||
    typeof total !== 'number' ||
    !Number.isFinite(processed) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
}

/**
 * Ensures exactly one stage is marked current when the job is active.
 * @param {object[]} stages Stage rows.
 * @param {string} jobStatus Job status.
 * @returns {object[]}
 */
function ensureSingleCurrent(stages, jobStatus) {
  const isActive =
    jobStatus === 'running' || jobStatus === 'pending' || jobStatus === 'retrying';
  if (!isActive) {
    return stages.map((stage) =>
      stage.state === 'current' ? { ...stage, state: 'pending' } : stage,
    );
  }
  let seenCurrent = false;
  return stages.map((stage) => {
    if (stage.state !== 'current') {
      return stage;
    }
    if (seenCurrent) {
      return { ...stage, state: 'pending' };
    }
    seenCurrent = true;
    return stage;
  });
}

/**
 * Projects the human-readable progress block for job detail.
 * @param {object} job Job document or lean object.
 * @param {object[]} [events] Ordered JobEvent documents.
 * @param {{ maxUserRetries?: number }} [options] Projection options.
 * @returns {object}
 */
export function projectJobProgress(job, events = [], options = {}) {
  const maxUserRetries = options.maxUserRetries ?? JOB_MAX_USER_RETRIES;
  const stages = ensureSingleCurrent(projectStages(job), job.jobStatus);
  const startedAt = toIsoOrNull(job.startedAt);
  const completedAt = toIsoOrNull(job.completedAt);
  let durationMs = null;
  if (job.startedAt instanceof Date && job.completedAt instanceof Date) {
    durationMs = Math.max(0, job.completedAt.getTime() - job.startedAt.getTime());
  }

  return {
    startedAt,
    completedAt,
    durationMs,
    percent: computePercent(job),
    itemsProcessed: job.progressCounters?.itemsProcessed ?? 0,
    itemsFailed: job.progressCounters?.itemsFailed ?? 0,
    stages,
    warnings: collectSeveritySummaries(events, 'warning'),
    errors: collectSeveritySummaries(events, 'error'),
    retry: describeRetryAvailability(job, maxUserRetries),
    cancellation: {
      requested: Boolean(job.cancelRequestedAt),
      requestedAt: toIsoOrNull(job.cancelRequestedAt),
    },
    knowledgeAvailability: deriveKnowledgeAvailability(job.jobStatus),
  };
}
