/**
 * Stable JobEvent codes mapped to human-readable English messages.
 * Messages never contain object ids, absolute paths, stack traces, or credentials.
 */
import { labelForJobStage } from './jobStageCatalog.js';

/** @type {Readonly<Record<string, string>>} */
export const JOB_EVENT_MESSAGES = Object.freeze({
  'source.received': 'Source received',
  'source.validated': 'Source validated',
  'source.exclusions_applied': 'Exclusions applied',
  'files.identified': 'Project files identified',
  'docs.analyzed': 'Documentation analyzed',
  'structure.analyzed': 'Project structure analyzed',
  'knowledge.updated': 'Project knowledge updated',
  'job.retry_requested': 'Retry requested',
  'job.cancelled': 'Processing cancelled',
  'job.enqueued': 'Processing is queued.',
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
