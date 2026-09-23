/**
 * Maps backend job / stage codes to icons, tones, and i18n keys.
 * Does not invent percent or stage progress.
 */
import { AlertTriangle, Check, Circle, Loader2, Minus, XCircle } from 'lucide-react';
import { ACTIVE_JOB_STATUSES, HISTORY_JOB_STATUSES } from './api/jobTypes.js';

/** @typedef {'neutral' | 'progress' | 'success' | 'attention' | 'danger'} JobTone */

/**
 * @typedef {{
 *   icon: import('lucide-react').LucideIcon,
 *   tone: JobTone,
 *   className: string,
 *   spin?: boolean,
 * }} StageVisual
 */

/** @type {Readonly<Record<string, Readonly<StageVisual>>>} */
export const STAGE_STATE_MAP = Object.freeze({
  completed: Object.freeze({
    icon: Check,
    tone: 'success',
    className: 'text-emerald-600',
  }),
  current: Object.freeze({
    icon: Loader2,
    tone: 'progress',
    className: 'text-blue-600',
    spin: true,
  }),
  pending: Object.freeze({
    icon: Circle,
    tone: 'neutral',
    className: 'text-muted-foreground/40',
  }),
  failed: Object.freeze({
    icon: XCircle,
    tone: 'danger',
    className: 'text-red-600',
  }),
  skipped: Object.freeze({
    icon: Minus,
    tone: 'neutral',
    className: 'text-muted-foreground/50',
  }),
});

/** @type {Readonly<StageVisual>} */
export const UNKNOWN_STAGE_VISUAL = Object.freeze({
  icon: Circle,
  tone: 'neutral',
  className: 'text-muted-foreground/40',
});

/** @type {Readonly<Record<string, Readonly<StageVisual>>>} */
export const JOB_STATUS_MAP = Object.freeze({
  pending: Object.freeze({
    icon: Circle,
    tone: 'neutral',
    className: 'text-muted-foreground',
  }),
  running: Object.freeze({
    icon: Loader2,
    tone: 'progress',
    className: 'text-blue-600',
    spin: true,
  }),
  retrying: Object.freeze({
    icon: Loader2,
    tone: 'progress',
    className: 'text-blue-600',
    spin: true,
  }),
  completed: Object.freeze({
    icon: Check,
    tone: 'success',
    className: 'text-emerald-600',
  }),
  completed_with_warnings: Object.freeze({
    icon: AlertTriangle,
    tone: 'attention',
    className: 'text-amber-600',
  }),
  failed: Object.freeze({
    icon: XCircle,
    tone: 'danger',
    className: 'text-red-600',
  }),
  cancelled: Object.freeze({
    icon: Minus,
    tone: 'neutral',
    className: 'text-muted-foreground',
  }),
});

/** @type {Readonly<StageVisual>} */
export const UNKNOWN_JOB_STATUS_VISUAL = Object.freeze({
  icon: Circle,
  tone: 'neutral',
  className: 'text-muted-foreground',
});

/**
 * Maps a stage.state value to icon and tone.
 * @param {string | null | undefined} state Backend stage state.
 * @returns {Readonly<StageVisual>}
 */
export function mapStageState(state) {
  if (typeof state !== 'string' || state.length === 0) {
    return UNKNOWN_STAGE_VISUAL;
  }
  return STAGE_STATE_MAP[state] ?? UNKNOWN_STAGE_VISUAL;
}

/**
 * Maps a jobStatus value to a history glyph.
 * @param {string | null | undefined} jobStatus Backend job status.
 * @returns {Readonly<StageVisual>}
 */
export function mapJobStatus(jobStatus) {
  if (typeof jobStatus !== 'string' || jobStatus.length === 0) {
    return UNKNOWN_JOB_STATUS_VISUAL;
  }
  return JOB_STATUS_MAP[jobStatus] ?? UNKNOWN_JOB_STATUS_VISUAL;
}

/**
 * True when the job is still in flight.
 * @param {string | null | undefined} jobStatus Backend job status.
 * @returns {boolean}
 */
export function isActiveJobStatus(jobStatus) {
  return ACTIVE_JOB_STATUSES.includes(/** @type {string} */ (jobStatus));
}

/**
 * True when the job belongs in history.
 * @param {string | null | undefined} jobStatus Backend job status.
 * @returns {boolean}
 */
export function isHistoryJobStatus(jobStatus) {
  return HISTORY_JOB_STATUSES.includes(/** @type {string} */ (jobStatus));
}

/**
 * i18n key for a job type, or the unknown fallback.
 * @param {string | null | undefined} jobType Backend job type.
 * @returns {string}
 */
export function jobTypeLabelKey(jobType) {
  if (typeof jobType !== 'string' || jobType.length === 0) {
    return 'processing.jobType.unknown';
  }
  return `processing.jobType.${jobType}`;
}

/**
 * i18n key for a stage id (header chip when detail labels are not loaded).
 * @param {string | null | undefined} stage Stage id.
 * @returns {string}
 */
export function stageLabelKey(stage) {
  if (typeof stage !== 'string' || stage.length === 0) {
    return 'processing.stage.unknown';
  }
  return `processing.stage.${stage}`;
}

/**
 * i18n key for a job status.
 * @param {string | null | undefined} jobStatus Backend job status.
 * @returns {string}
 */
export function jobStatusLabelKey(jobStatus) {
  if (typeof jobStatus !== 'string' || jobStatus.length === 0) {
    return 'processing.jobStatus.unknown';
  }
  return `processing.jobStatus.${jobStatus}`;
}

/**
 * Picks the header / banner job: running/retrying first, then oldest pending.
 * @param {Array<{ jobStatus?: string, createdAt?: string | null }>} jobs List items.
 * @returns {object | null}
 */
export function selectActiveJob(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return null;
  }
  const inFlight = jobs.filter(
    (job) => job.jobStatus === 'running' || job.jobStatus === 'retrying',
  );
  if (inFlight.length > 0) {
    return inFlight[0];
  }
  const pending = jobs
    .filter((job) => job.jobStatus === 'pending')
    .slice()
    .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
  return pending[0] ?? null;
}

/**
 * True when a numeric percent should be rendered.
 * @param {unknown} percent Backend percent (null when unknown).
 * @returns {boolean}
 */
export function hasRenderablePercent(percent) {
  return typeof percent === 'number' && Number.isFinite(percent);
}
