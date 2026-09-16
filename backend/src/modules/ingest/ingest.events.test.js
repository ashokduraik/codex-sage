/**
 * Unit tests for user-readable ingest JobEvent builders.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDocumentationIdentifiedEvent,
  buildExclusionsAppliedEvent,
  buildFilesIdentifiedEvent,
  buildSourceReceivedEvent,
  buildSourceValidatedEvent,
  buildWorkspaceMaterializedEvent,
} from './ingest.events.js';
import {
  messageContainsAbsolutePath,
  messageContainsObjectIdShape,
  messageContainsRawErrorFragment,
} from '../jobs/jobEventCatalog.js';

describe('ingest.events', () => {
  it('builds Source received without identifiers', () => {
    const event = buildSourceReceivedEvent();
    expect(event.message).toBe('Source received');
    expect(messageContainsObjectIdShape(event.message)).toBe(false);
  });

  it('builds Source validated with an honest count', () => {
    const event = buildSourceValidatedEvent(312);
    expect(event.eventCode).toBe('source.validated');
    expect(event.message).toBe('Source validated (312 files)');
    expect(event.data.filesTotal).toBe(312);
  });

  it('omits the failed clause when M = 0 and includes it when M > 0', () => {
    expect(buildFilesIdentifiedEvent({ filesProcessed: 12, filesFailed: 0 }).message).toBe(
      'Project files identified (12 files)',
    );
    expect(buildFilesIdentifiedEvent({ filesProcessed: 12, filesFailed: 3 }).message).toBe(
      'Project files identified (12 files, 3 failed)',
    );
  });

  it('builds Exclusions applied with a path count and safe message shape', () => {
    const event = buildExclusionsAppliedEvent({
      excludedPaths: 312,
      filesProcessed: 4812,
      filesFailed: 9,
    });
    expect(event.message).toBe('Exclusions applied (312 paths)');
    expect(messageContainsAbsolutePath(event.message)).toBe(false);
    expect(messageContainsRawErrorFragment(event.message)).toBe(false);
    expect(event.data).toEqual({
      excludedPaths: 312,
      filesProcessed: 4812,
      filesFailed: 9,
    });
  });

  it('builds workspace materialized and documentation identified events', () => {
    expect(buildWorkspaceMaterializedEvent({ pathsWritten: 42 }).message).toBe(
      'Project files materialized (42 paths)',
    );
    expect(
      buildDocumentationIdentifiedEvent({
        documentationFiles: 3,
        documentationSections: 12,
        failedDocuments: 0,
      }).message,
    ).toBe('Documentation identified (3 files, 12 sections)');
    expect(
      buildDocumentationIdentifiedEvent({
        documentationFiles: 3,
        documentationSections: 12,
        failedDocuments: 1,
      }).message,
    ).toBe('Documentation identified (3 files, 12 sections, 1 failed)');
  });
});
