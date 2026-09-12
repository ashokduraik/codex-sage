/**
 * Unit tests for the human-readable job event catalogue.
 */
import { describe, expect, it } from 'vitest';
import {
  JOB_EVENT_MESSAGES,
  messageContainsAbsolutePath,
  messageContainsObjectIdShape,
  messageContainsRawErrorFragment,
  renderJobEventMessage,
} from './jobEventCatalog.js';

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
        jobType: 'ingest',
        fromStage: 'materialize_docs',
      }),
    ).toBe('Retry requested; resuming from documentation analyzed');

    expect(
      renderJobEventMessage('source.exclusions_applied', { skippedPathCount: 1203 }),
    ).toBe('Exclusions applied (1,203 paths skipped)');
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
