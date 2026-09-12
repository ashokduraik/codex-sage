/**
 * Stable JobEvent codes mapped to human-readable English messages.
 * Messages never contain object ids, absolute paths, stack traces, or credentials.
 */
import { labelForJobStage } from './jobStageCatalog.js';

/** @type {Readonly<Record<string, string>>} */
export const JOB_EVENT_MESSAGES = Object.freeze({
  'source.received': 'Source received',
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
 * Renders a catalogue message for an event code.
 * Unknown codes fall back to a safe generic phrase (never raw diagnostics).
 * @param {string} eventCode Stable event code.
 * @param {{
 *   jobType?: string,
 *   fromStage?: string | null,
 *   skippedPathCount?: number,
 * }} [context] Optional render context (counts/labels only).
 * @returns {string}
 */
export function renderJobEventMessage(eventCode, context = {}) {
  if (eventCode === 'job.retry_requested' && context.fromStage) {
    const label = labelForJobStage(context.jobType ?? 'ingest', context.fromStage);
    return `Retry requested; resuming from ${label.toLowerCase()}`;
  }
  if (
    eventCode === 'source.exclusions_applied' &&
    typeof context.skippedPathCount === 'number' &&
    Number.isFinite(context.skippedPathCount)
  ) {
    const count = Math.max(0, Math.floor(context.skippedPathCount));
    return `Exclusions applied (${count.toLocaleString('en-US')} paths skipped)`;
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
