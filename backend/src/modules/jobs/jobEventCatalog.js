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
