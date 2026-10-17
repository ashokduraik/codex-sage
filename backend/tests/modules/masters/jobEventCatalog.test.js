/**
 * Unit tests for the human-readable job event catalogue.
 */
import { describe, expect, it } from 'vitest';
import { JOB_EVENT_MESSAGES, renderJobEventMessage } from '../../../src/modules/masters/jobs.helper.js';
import { messageContainsAbsolutePath, messageContainsObjectIdShape, messageContainsRawErrorFragment } from '../../jobEventAssertions.js';

describe('jobEventCatalog', () => {
  it('renders every catalogue code without ids, paths, or Error: fragments', () => {
    for (const [code, message] of Object.entries(JOB_EVENT_MESSAGES)) {
      expect(messageContainsObjectIdShape(message)).toBe(false);
      expect(messageContainsAbsolutePath(message)).toBe(false);
      expect(messageContainsRawErrorFragment(message)).toBe(false);
      expect(renderJobEventMessage(code)).toBe(message);
    }
  });

  it('renders retry and exclusion messages with safe context only', () => {
    expect(
      renderJobEventMessage('job.retry_requested', {
        jobType: 'project_knowledge_build',
        fromStage: 'materialize_docs',
      }),
    ).toBe('Retry requested; resuming from documentation analyzed');

    expect(renderJobEventMessage('source.exclusions_applied', { skippedPathCount: 1203 })).toBe('Exclusions applied (1,203 paths)');
    expect(renderJobEventMessage('source.validated', { filesTotal: 42 })).toBe('Source validated (42 files)');
    expect(renderJobEventMessage('files.identified', { filesProcessed: 4812, filesFailed: 0 })).toBe('Project files identified (4,812 files)');
    expect(renderJobEventMessage('files.identified', { filesProcessed: 4812, filesFailed: 9 })).toBe(
      'Project files identified (4,812 files, 9 failed)',
    );
    expect(renderJobEventMessage('workspace.materialized', { pathsWritten: 1203 })).toBe('Project files materialized (1,203 paths)');
    expect(
      renderJobEventMessage('docs.identified', {
        documentationFiles: 4,
        documentationSections: 18,
      }),
    ).toBe('Documentation identified (4 files, 18 sections)');
    expect(renderJobEventMessage('structure.analyzed', { indexedFiles: 4200, skippedFiles: 12 })).toBe(
      'Project structure analyzed (4,200 files, 12 skipped)',
    );
    expect(renderJobEventMessage('relationships.analyzed', { indexedFiles: 4200 })).toBe('Code relationships analyzed (4,200 files)');
  });

  it('falls back safely for unknown codes', () => {
    expect(renderJobEventMessage('totally.unknown')).toBe('Processing update');
  });

  it('detects unsafe message shapes', () => {
    expect(messageContainsObjectIdShape('see 665f1c9d4b2a8e0012a4f001')).toBe(true);
    expect(messageContainsAbsolutePath('wrote /tmp/secret.bin')).toBe(true);
    expect(messageContainsRawErrorFragment('Error: boom')).toBe(true);
  });
});
