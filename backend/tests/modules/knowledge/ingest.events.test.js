/**
 * Unit tests for user-readable ingest JobEvent builders.
 */
import { describe, expect, it } from 'vitest';
import { messageContainsAbsolutePath, messageContainsObjectIdShape, messageContainsRawErrorFragment } from '../../jobEventAssertions.js';
import {
  buildKnowledgeReadyEvent,
  buildSourceReceivedEvent,
  buildFilesIdentifiedEvent,
  buildSourceValidatedEvent,
  buildKnowledgeUpdatedEvent,
  buildExclusionsAppliedEvent,
  buildKnowledgeValidatedEvent,
  buildWorkspaceMaterializedEvent,
  buildDocumentationIdentifiedEvent,
  buildProjectStructureAnalyzedEvent,
  buildCodeRelationshipsAnalyzedEvent,
} from '../../../src/modules/knowledge/ingest.helper.js';

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
    expect(buildFilesIdentifiedEvent({ filesProcessed: 12, filesFailed: 0 }).message).toBe('Project files identified (12 files)');
    expect(buildFilesIdentifiedEvent({ filesProcessed: 12, filesFailed: 3 }).message).toBe('Project files identified (12 files, 3 failed)');
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
    expect(buildWorkspaceMaterializedEvent({ pathsWritten: 42 }).message).toBe('Project files materialized (42 paths)');
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

  it('builds S4 structure and relationships events with honest counts', () => {
    expect(buildProjectStructureAnalyzedEvent({ indexedFiles: 42, skippedFiles: 0 }).message).toBe('Project structure analyzed (42 files)');
    expect(buildProjectStructureAnalyzedEvent({ indexedFiles: 42, skippedFiles: 3 }).message).toBe(
      'Project structure analyzed (42 files, 3 skipped)',
    );
    expect(buildCodeRelationshipsAnalyzedEvent({ indexedFiles: 42 }).message).toBe('Code relationships analyzed (42 files)');
    expect(messageContainsAbsolutePath(buildProjectStructureAnalyzedEvent({ indexedFiles: 1 }).message)).toBe(false);
  });

  it('builds S5/S6 knowledge events', () => {
    expect(buildKnowledgeUpdatedEvent().message).toBe('Project knowledge updated');
    expect(buildKnowledgeValidatedEvent().message).toBe('Knowledge validated');
    expect(buildKnowledgeReadyEvent().message).toBe('Ready');
  });
});
