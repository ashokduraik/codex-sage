/**
 * User-readable JobEvent message builders for ingest stages (backend §34).
 */
import { renderJobEventMessage } from '../jobs/jobEventCatalog.js';

/**
 * Builds the S0 "source received" event.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildSourceReceivedEvent() {
  return {
    eventCode: 'source.received',
    severity: 'info',
    message: renderJobEventMessage('source.received'),
    data: {},
  };
}

/**
 * Builds the S0 "source validated" event with an honest file count.
 * @param {number} filesTotal Accepted file count after validation.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildSourceValidatedEvent(filesTotal) {
  const count = Math.max(0, Math.floor(filesTotal));
  return {
    eventCode: 'source.validated',
    severity: 'info',
    message: renderJobEventMessage('source.validated', { filesTotal: count }),
    data: { filesTotal: count },
  };
}

/**
 * Builds the S1 "project files identified" event.
 * @param {{ filesProcessed: number, filesFailed: number }} counts Honest counts.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildFilesIdentifiedEvent(counts) {
  const filesProcessed = Math.max(0, Math.floor(counts.filesProcessed));
  const filesFailed = Math.max(0, Math.floor(counts.filesFailed));
  return {
    eventCode: 'files.identified',
    severity: filesFailed > 0 ? 'warning' : 'info',
    message: renderJobEventMessage('files.identified', { filesProcessed, filesFailed }),
    data: { filesProcessed, filesFailed },
  };
}

/**
 * Builds the S2 "exclusions applied" event.
 * @param {{ excludedPaths: number, filesProcessed: number, filesFailed: number }} counts Counts.
 * @returns {{ eventCode: string, severity: string, message: string, data: object }}
 */
export function buildExclusionsAppliedEvent(counts) {
  const excludedPaths = Math.max(0, Math.floor(counts.excludedPaths));
  return {
    eventCode: 'source.exclusions_applied',
    severity: 'info',
    message: renderJobEventMessage('source.exclusions_applied', {
      excludedPaths,
    }),
    data: {
      excludedPaths,
      filesProcessed: Math.max(0, Math.floor(counts.filesProcessed)),
      filesFailed: Math.max(0, Math.floor(counts.filesFailed)),
    },
  };
}
