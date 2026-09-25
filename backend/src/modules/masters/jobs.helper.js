/**
 * masters/jobs.helper.js — merged resource file.
 */
import {
  FAILURE_CLASS_VALUES,
  JOB_DEFAULT_MAX_ATTEMPTS,
  JOB_STATUS_VALUES,
  JOB_TYPE_VALUES,
  Job,
} from '../../models/job.model.js';
import { JOB_EVENT_SEVERITY_VALUES, JobEvent } from '../../models/jobEvent.model.js';
import { assertOrgId, decodeCursor, encodeCursor, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { ApiError } from '../../platform/errors.js';
import mongoose from 'mongoose';

// --- from jobs/jobs.constants.js ---
/**
 * Named constants for the jobs module (not env).
 */

/** Default page size for GET /projects/:projectId/jobs. */
export const JOB_LIST_PAGE_SIZE_DEFAULT = 20;

/** Hard cap on the `limit` query parameter. */
export const JOB_LIST_PAGE_SIZE_MAX = 100;

/** Maximum stored JobEvent.message length (reject over, never truncate). */
export const JOB_EVENT_MESSAGE_MAX_LENGTH = 500;

/**
 * Default maxAttempts copied onto new jobs.
 * Phase 21 worker imports this rather than introducing an env var.
 */
export {
  FAILURE_CLASS_VALUES,
  JOB_DEFAULT_MAX_ATTEMPTS,
  JOB_EVENT_SEVERITY_VALUES,
  JOB_STATUS_VALUES,
  JOB_TYPE_VALUES,
};

/** Event code written by createPendingJob. */
export const JOB_EVENT_CODE_ENQUEUED = 'job.enqueued';

/** User-facing enqueue message (no ids/stacks). */
export const JOB_ENQUEUED_MESSAGE = 'Processing is queued.';

/** How long a cancel request may wait for the worker before a sweeper may finish it. */
export const JOB_CANCEL_GRACE_MS = 60_000;

/** Ceiling on user-initiated retries per job (distinct from worker attempt). */
export const JOB_MAX_USER_RETRIES = 10;

/** Job statuses that count as an active writer for duplicate-click protection. */
export const ACTIVE_JOB_STATUSES = Object.freeze(['pending', 'retrying', 'running']);

// --- from jobs/jobStageCatalog.js ---
/**
 * Ordered stage lists and human-readable labels per job type.
 * Shared by the worker, progress projection, and tests so they cannot drift.
 */

/**
 * @typedef {{ stage: string, label: string }} JobStageDefinition
 */

/** Ingest pipeline stages (solution §4.6 S0–S6). */
export const INGEST_STAGE_DEFINITIONS = Object.freeze([
  Object.freeze({ stage: 'validate_upload', label: 'Source received' }),
  Object.freeze({ stage: 'store_files', label: 'Project files identified' }),
  Object.freeze({ stage: 'exclude_apply', label: 'Exclusions applied' }),
  Object.freeze({ stage: 'materialize_docs', label: 'Documentation analyzed' }),
  Object.freeze({ stage: 'codegraph_update', label: 'Project structure analyzed' }),
  Object.freeze({ stage: 'knowledge_publish', label: 'Project knowledge updated' }),
  Object.freeze({ stage: 'finalize', label: 'Processing finalized' }),
]);

/**
 * Stage definitions keyed by job type.
 * reingest reuses ingest stages. repo_sync has its own short fetch/persist list.
 * @type {Readonly<Record<string, readonly JobStageDefinition[]>>}
 */
export const JOB_STAGE_CATALOG = Object.freeze({
  ingest: INGEST_STAGE_DEFINITIONS,
  reingest: INGEST_STAGE_DEFINITIONS,
  repo_sync: Object.freeze([
    Object.freeze({ stage: 'fetch_remote', label: 'Checking repository' }),
    Object.freeze({ stage: 'persist_source', label: 'Saving source files' }),
    Object.freeze({ stage: 'enqueue_ingest', label: 'Queued for processing' }),
  ]),
  worker_smoke: Object.freeze([
    Object.freeze({ stage: 'smoke_run', label: 'Worker smoke check' }),
  ]),
});

/**
 * Returns the ordered stage definitions for a job type (empty when unknown).
 * @param {string} jobType Job type.
 * @returns {readonly JobStageDefinition[]}
 */
export function listStagesForJobType(jobType) {
  return JOB_STAGE_CATALOG[jobType] ?? Object.freeze([]);
}

/**
 * Returns the label for a stage within a job type, or the stage id as fallback.
 * @param {string} jobType Job type.
 * @param {string} stage Stage id.
 * @returns {string}
 */
export function labelForJobStage(jobType, stage) {
  const found = listStagesForJobType(jobType).find((entry) => entry.stage === stage);
  return found?.label ?? stage;
}

// --- from jobs/jobEventCatalog.js ---
/**
 * Stable JobEvent codes mapped to human-readable English messages.
 * Messages never contain object ids, absolute paths, stack traces, or credentials.
 */
/** @type {Readonly<Record<string, string>>} */
export const JOB_EVENT_MESSAGES = Object.freeze({
  'source.received': 'Source received',
  'source.validated': 'Source validated',
  'source.exclusions_applied': 'Exclusions applied',
  'files.identified': 'Project files identified',
  'workspace.materialized': 'Project files materialized',
  'docs.identified': 'Documentation identified',
  'docs.analyzed': 'Documentation analyzed',
  'structure.analyzed': 'Project structure analyzed',
  'relationships.analyzed': 'Code relationships analyzed',
  'knowledge.updated': 'Project knowledge updated',
  'knowledge.validated': 'Knowledge validated',
  'knowledge.ready': 'Ready',
  'job.retry_requested': 'Retry requested',
  'job.cancelled': 'Processing cancelled',
  'job.enqueued': 'Processing is queued.',
  'repo.sync.no_changes': 'No changes on the selected branch',
  'repo.sync.deferred': 'Sync deferred because the project is busy.',
  'repo.sync.source_enqueued': 'Source queued for processing.',
});

/**
 * Formats a non-negative integer with en-US grouping.
 * @param {number} value Count.
 * @returns {string}
 */
function formatCount(value) {
  return Math.max(0, Math.floor(value)).toLocaleString('en-US');
}

/**
 * Renders a catalogue message for an event code.
 * Unknown codes fall back to a safe generic phrase (never raw diagnostics).
 * @param {string} eventCode Stable event code.
 * @param {{
 *   jobType?: string,
 *   fromStage?: string | null,
 *   skippedPathCount?: number,
 *   excludedPaths?: number,
 *   filesTotal?: number,
 *   filesProcessed?: number,
 *   filesFailed?: number,
 *   pathsWritten?: number,
 *   documentationFiles?: number,
 *   documentationSections?: number,
 *   failedDocuments?: number,
 *   indexedFiles?: number,
 *   skippedFiles?: number,
 * }} [context] Optional render context (counts/labels only).
 * @returns {string}
 */
export function renderJobEventMessage(eventCode, context = {}) {
  if (eventCode === 'job.retry_requested' && context.fromStage) {
    const label = labelForJobStage(context.jobType ?? 'ingest', context.fromStage);
    return `Retry requested; resuming from ${label.toLowerCase()}`;
  }
  if (eventCode === 'source.validated' && typeof context.filesTotal === 'number') {
    return `Source validated (${formatCount(context.filesTotal)} files)`;
  }
  if (eventCode === 'files.identified' && typeof context.filesProcessed === 'number') {
    const processed = formatCount(context.filesProcessed);
    const failed =
      typeof context.filesFailed === 'number' ? Math.max(0, Math.floor(context.filesFailed)) : 0;
    if (failed > 0) {
      return `Project files identified (${processed} files, ${formatCount(failed)} failed)`;
    }
    return `Project files identified (${processed} files)`;
  }
  if (eventCode === 'source.exclusions_applied') {
    const count =
      typeof context.excludedPaths === 'number'
        ? context.excludedPaths
        : typeof context.skippedPathCount === 'number'
          ? context.skippedPathCount
          : null;
    if (typeof count === 'number' && Number.isFinite(count)) {
      return `Exclusions applied (${formatCount(count)} paths)`;
    }
  }
  if (eventCode === 'workspace.materialized' && typeof context.pathsWritten === 'number') {
    return `Project files materialized (${formatCount(context.pathsWritten)} paths)`;
  }
  if (eventCode === 'docs.identified' && typeof context.documentationFiles === 'number') {
    const files = formatCount(context.documentationFiles);
    const sections =
      typeof context.documentationSections === 'number'
        ? formatCount(context.documentationSections)
        : '0';
    const failed =
      typeof context.failedDocuments === 'number'
        ? Math.max(0, Math.floor(context.failedDocuments))
        : 0;
    if (failed > 0) {
      return `Documentation identified (${files} files, ${sections} sections, ${formatCount(failed)} failed)`;
    }
    return `Documentation identified (${files} files, ${sections} sections)`;
  }
  if (eventCode === 'structure.analyzed' && typeof context.indexedFiles === 'number') {
    const indexed = formatCount(context.indexedFiles);
    const skipped =
      typeof context.skippedFiles === 'number' ? Math.max(0, Math.floor(context.skippedFiles)) : 0;
    if (skipped > 0) {
      return `Project structure analyzed (${indexed} files, ${formatCount(skipped)} skipped)`;
    }
    return `Project structure analyzed (${indexed} files)`;
  }
  if (eventCode === 'relationships.analyzed' && typeof context.indexedFiles === 'number') {
    return `Code relationships analyzed (${formatCount(context.indexedFiles)} files)`;
  }
  return JOB_EVENT_MESSAGES[eventCode] ?? 'Processing update';
}

/**
 * Returns true when a message looks like it embeds an ObjectId hex string.
 * @param {string} message Candidate message.
 * @returns {boolean}
 */
export function messageContainsObjectIdShape(message) {
  return /\b[a-f0-9]{24}\b/i.test(message);
}

/**
 * Returns true when a message looks like an absolute filesystem path.
 * @param {string} message Candidate message.
 * @returns {boolean}
 */
export function messageContainsAbsolutePath(message) {
  return /(^|\s)(\/[^\s]+|[A-Za-z]:\\[^\s]+)/.test(message);
}

/**
 * Returns true when a message looks like a raw error / stack fragment.
 * @param {string} message Candidate message.
 * @returns {boolean}
 */
export function messageContainsRawErrorFragment(message) {
  return /\bError:\s/i.test(message) || /\bat\s+\S+\s+\(/.test(message);
}

// --- from jobs/jobRetryMode.js ---
/**
 * Resolves user-facing retry mode from stored failure state (never from client input).
 */

/** Stages whose bytes are wrong — user must upload again (solution §4.6 S0). */
const USER_ACTION_UPLOAD_STAGES = new Set(['validate_upload', 'store_files']);

/** Stages that require a full pipeline rebuild when they fail permanently. */
const FULL_REBUILD_STAGES = new Set(['codegraph_update', 'knowledge_publish']);

/**
 * @typedef {{
 *   mode: 'resume' | 'full' | 'not_retryable',
 *   fromStage: string | null,
 *   reason: string | null,
 * }} JobRetryResolution
 */

/**
 * Resolves retry mode for a failed or cancelled job.
 * @param {{
 *   jobStatus: string,
 *   failureClass?: string | null,
 *   currentStage?: string | null,
 *   stageCheckpoint?: { lastCompletedStage?: string | null } | null,
 * }} job Job document fields.
 * @returns {JobRetryResolution}
 */
export function resolveJobRetryMode(job) {
  const failedStage = job.currentStage ?? null;
  const lastCompleted = job.stageCheckpoint?.lastCompletedStage ?? null;
  const failureClass = job.failureClass ?? null;

  if (
    failureClass === 'user_action_required' &&
    failedStage &&
    USER_ACTION_UPLOAD_STAGES.has(failedStage)
  ) {
    return {
      mode: 'not_retryable',
      fromStage: null,
      reason:
        'This upload cannot be retried. Remove excluded or invalid content and upload the project again.',
    };
  }

  if (failedStage && FULL_REBUILD_STAGES.has(failedStage)) {
    return {
      mode: 'full',
      fromStage: 'validate_upload',
      reason:
        'The project structure update failed. Retry re-runs processing from the start against the stored source.',
    };
  }

  if (failureClass === 'permanent' && (!lastCompleted || FULL_REBUILD_STAGES.has(failedStage ?? ''))) {
    return {
      mode: 'full',
      fromStage: 'validate_upload',
      reason:
        'This failure cannot be partially redone. Retry re-runs the full processing pipeline.',
    };
  }

  if (lastCompleted) {
    return {
      mode: 'resume',
      fromStage: failedStage ?? lastCompleted,
      reason: null,
    };
  }

  return {
    mode: 'full',
    fromStage: 'validate_upload',
    reason: 'No checkpoint is available. Retry re-runs processing from the start.',
  };
}

/**
 * Read-only retry availability for the job detail payload.
 * @param {object} job Job document fields.
 * @param {number} maxUserRetries Ceiling on user-initiated retries.
 * @returns {{ available: boolean, mode: 'resume' | 'full' | null, reason: string | null }}
 */
export function describeRetryAvailability(job, maxUserRetries) {
  const status = job.jobStatus;
  if (status !== 'failed' && status !== 'cancelled') {
    return { available: false, mode: null, reason: null };
  }
  if ((job.retryCount ?? 0) >= maxUserRetries) {
    return {
      available: false,
      mode: null,
      reason: 'This job has reached the maximum number of user-initiated retries.',
    };
  }
  const resolved = resolveJobRetryMode(job);
  if (resolved.mode === 'not_retryable') {
    return { available: false, mode: null, reason: resolved.reason };
  }
  return {
    available: true,
    mode: resolved.mode,
    reason: resolved.reason,
  };
}

// --- from jobs/jobProgress.js ---
/**
 * Derived progress projection for job detail (never stored twice).
 */
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

// --- from jobs/jobs.repository.js ---
/**
 * Jobs repository — tenant + project scoped job and event persistence.
 */
/**
 * Clamps a requested page size into the allowed range.
 * @param {unknown} limit Raw limit.
 * @returns {number}
 */
export function clampJobListLimit(limit) {
  if (limit === undefined || limit === null || limit === '') {
    return JOB_LIST_PAGE_SIZE_DEFAULT;
  }
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return JOB_LIST_PAGE_SIZE_DEFAULT;
  }
  return Math.min(Math.floor(parsed), JOB_LIST_PAGE_SIZE_MAX);
}

/**
 * Returns true when value is a known jobStatus.
 * @param {unknown} jobStatus Candidate status.
 * @returns {boolean}
 */
export function isKnownJobStatus(jobStatus) {
  return typeof jobStatus === 'string' && JOB_STATUS_VALUES.includes(jobStatus);
}

/**
 * Builds a keyset filter for createdAt/_id descending pages.
 * @param {{ t: string, i: string }} cursor Decoded cursor.
 * @returns {object}
 */
function keysetAfterCreatedAt(cursor) {
  const stamp = new Date(cursor.t);
  if (Number.isNaN(stamp.getTime())) {
    throw ApiError.fromCode('INVALID_CURSOR');
  }
  if (!mongoose.isValidObjectId(cursor.i)) {
    throw ApiError.fromCode('INVALID_CURSOR');
  }
  const id = new mongoose.Types.ObjectId(cursor.i);
  return {
    $or: [{ createdAt: { $lt: stamp } }, { createdAt: stamp, _id: { $lt: id } }],
  };
}

/**
 * Asserts event message length before write (never truncate).
 * @param {string} message Event message.
 * @throws {ApiError} VALIDATION_ERROR when over max length.
 */
export function assertJobEventMessageLength(message) {
  if (typeof message !== 'string' || message.length > JOB_EVENT_MESSAGE_MAX_LENGTH) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'message',
          message: `message must be at most ${JOB_EVENT_MESSAGE_MAX_LENGTH} characters`,
        },
      ],
    });
  }
}

/**
 * Inserts a pending job and its initial enqueued event.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId | string,
 *   jobType: string,
 *   createdBy?: import('mongoose').Types.ObjectId | string | null,
 *   correlationId?: string | null,
 *   sourceVersionId?: import('mongoose').Types.ObjectId | string | null,
 *   maxAttempts?: number,
 *   scheduledAt?: Date,
 * }} input Create fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<{ job: import('mongoose').Document, event: import('mongoose').Document }>}
 */
export async function insertPendingJob(input, options = {}) {
  assertOrgId(input.orgId);
  const now = input.scheduledAt instanceof Date ? input.scheduledAt : new Date();
  const maxAttempts =
    typeof input.maxAttempts === 'number' && input.maxAttempts >= 1
      ? input.maxAttempts
      : JOB_DEFAULT_MAX_ATTEMPTS;

  const job = new Job({
    orgId: input.orgId,
    projectId: input.projectId,
    jobType: input.jobType,
    jobStatus: 'pending',
    sourceVersionId: input.sourceVersionId ?? null,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
    correlationId: input.correlationId ?? null,
    workerId: null,
    attempt: 0,
    maxAttempts,
    heartbeatAt: null,
    leaseExpiresAt: null,
    scheduledAt: now,
    failureClass: null,
    failureCode: null,
    currentStage: null,
    stageCheckpoint: null,
    progressCounters: {
      itemsProcessed: 0,
      itemsFailed: 0,
      warningCount: 0,
      excludedCount: 0,
    },
    partialSuccess: false,
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    retryRequestedAt: null,
    retryRequestedBy: null,
    retryCount: 0,
    lastRetryMode: null,
    startedAt: null,
    completedAt: null,
  });

  assertJobEventMessageLength(JOB_ENQUEUED_MESSAGE);

  const event = new JobEvent({
    orgId: input.orgId,
    projectId: input.projectId,
    jobId: job._id,
    eventCode: JOB_EVENT_CODE_ENQUEUED,
    severity: 'info',
    message: JOB_ENQUEUED_MESSAGE,
    data: {},
    correlationId: input.correlationId ?? null,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
  });

  if (options.session) {
    await job.save({ session: options.session });
    await event.save({ session: options.session });
  } else {
    await job.save();
    await event.save();
  }

  return { job, event };
}

/**
 * Finds an active job by id within an org.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} jobId Job id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findJobById(orgId, jobId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(jobId)) {
    return null;
  }
  return Job.findOne({ _id: jobId, orgId, status: ROW_STATUS_ACTIVE }).exec();
}

/**
 * Lists active jobs for a project with keyset pagination.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} projectId Project id.
 * @param {{
 *   cursor?: string,
 *   limit?: unknown,
 *   jobStatus?: string,
 * }} [filters] List filters.
 * @returns {Promise<{
 *   items: import('mongoose').Document[],
 *   pageInfo: { nextCursor: string | null, hasMore: boolean },
 * }>}
 */
export async function listJobsByProject(orgId, projectId, filters = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(projectId)) {
    return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
  }

  const limit = clampJobListLimit(filters.limit);
  /** @type {Record<string, unknown>} */
  const query = {
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    status: ROW_STATUS_ACTIVE,
  };

  if (filters.jobStatus !== undefined && filters.jobStatus !== null && filters.jobStatus !== '') {
    if (!isKnownJobStatus(filters.jobStatus)) {
      throw ApiError.fromCode('VALIDATION_ERROR', {
        details: [{ path: 'jobStatus', message: 'jobStatus is not a known value' }],
      });
    }
    query.jobStatus = filters.jobStatus;
  }

  if (filters.cursor) {
    const decoded = decodeCursor(filters.cursor);
    Object.assign(query, keysetAfterCreatedAt(decoded));
  }

  const rows = await Job.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .exec();

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor({
      t: last.createdAt.toISOString(),
      i: String(last._id),
    });
  }
  return { items, pageInfo: { nextCursor, hasMore } };
}

/**
 * Lists active events for a job in ascending createdAt order.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {string} jobId Job id.
 * @returns {Promise<import('mongoose').Document[]>}
 */
export async function listEventsForJob(orgId, jobId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(jobId)) {
    return [];
  }
  return JobEvent.find({
    orgId,
    jobId: new mongoose.Types.ObjectId(String(jobId)),
    status: ROW_STATUS_ACTIVE,
  })
    .sort({ createdAt: 1, _id: 1 })
    .exec();
}

/**
 * Appends a job event (used by createPendingJob and later worker phases).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: import('mongoose').Types.ObjectId | string,
 *   jobId: import('mongoose').Types.ObjectId | string,
 *   eventCode: string,
 *   severity: 'info' | 'warning' | 'error',
 *   message: string,
 *   data?: object,
 *   correlationId?: string | null,
 *   createdBy?: import('mongoose').Types.ObjectId | string | null,
 * }} input Event fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Optional session.
 * @returns {Promise<import('mongoose').Document>}
 */
export async function appendJobEvent(input, options = {}) {
  assertOrgId(input.orgId);
  assertJobEventMessageLength(input.message);
  const event = new JobEvent({
    orgId: input.orgId,
    projectId: input.projectId,
    jobId: input.jobId,
    eventCode: input.eventCode,
    severity: input.severity,
    message: input.message,
    data: input.data && typeof input.data === 'object' ? input.data : {},
    correlationId: input.correlationId ?? null,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
  });
  if (options.session) {
    await event.save({ session: options.session });
  } else {
    await event.save();
  }
  return event;
}

/**
 * Finds an active job of the given types for a project.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} projectId Project id.
 * @param {string[]} jobTypes Job types to match.
 * @param {{ excludeJobId?: string | null }} [options] Optional current-job exclusion.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findActiveJobForProjectByTypes(orgId, projectId, jobTypes, options = {}) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(String(projectId)) || !Array.isArray(jobTypes) || jobTypes.length === 0) {
    return null;
  }
  /** @type {Record<string, unknown>} */
  const filter = {
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    status: ROW_STATUS_ACTIVE,
    jobType: { $in: jobTypes },
    jobStatus: { $in: ['pending', 'retrying', 'running'] },
  };
  if (options.excludeJobId && mongoose.isValidObjectId(String(options.excludeJobId))) {
    filter._id = { $ne: new mongoose.Types.ObjectId(String(options.excludeJobId)) };
  }
  return Job.findOne(filter).sort({ updatedAt: -1, _id: -1 }).exec();
}

/**
 * Returns a running job to pending and bumps scheduledAt without burning an attempt.
 * @param {{
 *   jobId: string | import('mongoose').Types.ObjectId,
 *   orgId: string | import('mongoose').Types.ObjectId,
 *   delayMs: number,
 * }} input Defer fields.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function deferRunningJob(input) {
  assertOrgId(input.orgId);
  const delayMs = Math.max(1, Math.floor(input.delayMs));
  return Job.findOneAndUpdate(
    {
      _id: input.jobId,
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
    },
    [
      {
        $set: {
          jobStatus: 'pending',
          workerId: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          attempt: { $max: [0, { $subtract: ['$attempt', 1] }] },
          scheduledAt: { $add: ['$$NOW', delayMs] },
          updatedAt: '$$NOW',
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).exec();
}

/**
 * Finds the newest active writer job for a project (pending, retrying, or running).
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} projectId Project id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findActiveJobForProject(orgId, projectId) {
  assertOrgId(orgId);
  if (!mongoose.isValidObjectId(String(projectId))) {
    return null;
  }
  return Job.findOne({
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    status: ROW_STATUS_ACTIVE,
    jobStatus: { $in: ['pending', 'retrying', 'running'] },
  })
    .sort({ updatedAt: -1, _id: -1 })
    .exec();
}

/**
 * Finds an active ingest or reingest job for a source version.
 * @param {import('mongoose').Types.ObjectId | string} orgId Tenant id.
 * @param {import('mongoose').Types.ObjectId | string} projectId Project id.
 * @param {import('mongoose').Types.ObjectId | string} sourceVersionId Source version id.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function findActiveJobForSourceVersion(orgId, projectId, sourceVersionId) {
  assertOrgId(orgId);
  if (
    !mongoose.isValidObjectId(String(projectId)) ||
    !mongoose.isValidObjectId(String(sourceVersionId))
  ) {
    return null;
  }
  return Job.findOne({
    orgId,
    projectId: new mongoose.Types.ObjectId(String(projectId)),
    sourceVersionId: new mongoose.Types.ObjectId(String(sourceVersionId)),
    status: ROW_STATUS_ACTIVE,
    jobType: { $in: ['ingest', 'reingest'] },
    jobStatus: { $in: ['pending', 'retrying', 'running'] },
  })
    .sort({ updatedAt: -1, _id: -1 })
    .exec();
}

/**
 * Immediately cancels a pending or retrying job.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   jobId: string,
 *   actorUserId: import('mongoose').Types.ObjectId | string,
 *   expectedStatuses?: string[],
 * }} input Cancel inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function cancelQueuedJob(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.jobId)) {
    return null;
  }
  const expectedStatuses = input.expectedStatuses ?? ['pending', 'retrying'];
  return Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
      jobStatus: { $in: expectedStatuses },
    },
    {
      $set: {
        jobStatus: 'cancelled',
        completedAt: new Date(),
        updatedBy: input.actorUserId,
        workerId: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
      },
    },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Requests cancellation of a running job (cooperative; worker confirms later).
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   jobId: string,
 *   actorUserId: import('mongoose').Types.ObjectId | string,
 * }} input Cancel-request inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function requestRunningJobCancel(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.jobId)) {
    return null;
  }
  const now = new Date();
  return Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'running',
      cancelRequestedAt: null,
    },
    {
      $set: {
        cancelRequestedAt: now,
        cancelRequestedBy: input.actorUserId,
        updatedBy: input.actorUserId,
      },
    },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Begins a user-initiated retry: failed|cancelled → retrying with metadata.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   jobId: string,
 *   actorUserId: import('mongoose').Types.ObjectId | string,
 *   mode: 'resume' | 'full',
 *   clearCheckpoint: boolean,
 * }} input Retry inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function beginUserRetry(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.jobId)) {
    return null;
  }
  const now = new Date();
  /** @type {Record<string, unknown>} */
  const $set = {
    jobStatus: 'retrying',
    retryRequestedAt: now,
    retryRequestedBy: input.actorUserId,
    lastRetryMode: input.mode,
    scheduledAt: now,
    attempt: 0,
    completedAt: null,
    failureClass: null,
    failureCode: null,
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    updatedBy: input.actorUserId,
    workerId: null,
    heartbeatAt: null,
    leaseExpiresAt: null,
  };
  if (input.clearCheckpoint) {
    $set.stageCheckpoint = null;
    $set.currentStage = null;
  }
  return Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
      jobStatus: { $in: ['failed', 'cancelled'] },
    },
    {
      $set,
      $inc: { retryCount: 1 },
    },
    { returnDocument: 'after' },
  ).exec();
}

/**
 * Promotes a retrying job to pending so the worker can claim it.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   jobId: string,
 *   actorUserId: import('mongoose').Types.ObjectId | string,
 * }} input Promote inputs.
 * @returns {Promise<import('mongoose').Document | null>}
 */
export async function promoteRetryingJobToPending(input) {
  assertOrgId(input.orgId);
  if (!mongoose.isValidObjectId(input.jobId)) {
    return null;
  }
  return Job.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(input.jobId)),
      orgId: input.orgId,
      status: ROW_STATUS_ACTIVE,
      jobStatus: 'retrying',
    },
    {
      $set: {
        jobStatus: 'pending',
        updatedBy: input.actorUserId,
        scheduledAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  ).exec();
}
