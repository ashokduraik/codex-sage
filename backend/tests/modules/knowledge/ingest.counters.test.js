/**
 * Unit tests for ingest counters and progress flush throttling.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  INGEST_FILE_BATCH_SIZE,
  createIngestCounters,
  createProgressFlusher,
  derivePartialSuccess,
  toJobProgressCounters,
} from '../../../src/modules/knowledge/ingest.helper.js';

describe('ingest.counters', () => {
  it('maps domain counters onto Job.progressCounters fields', () => {
    const counters = createIngestCounters();
    counters.filesProcessed = 10;
    counters.filesFailed = 2;
    counters.filesExcluded = 3;
    expect(toJobProgressCounters(counters)).toEqual({
      itemsProcessed: 10,
      itemsFailed: 2,
      warningCount: 1,
      excludedCount: 3,
    });
  });

  it('derives partialSuccess when filesFailed or filesExcluded > 0 and otherwise completed', () => {
    const counters = createIngestCounters();
    expect(derivePartialSuccess(counters, true)).toBe(false);
    counters.filesFailed = 1;
    expect(derivePartialSuccess(counters, true)).toBe(true);
    expect(derivePartialSuccess(counters, false)).toBe(false);
    counters.filesFailed = 0;
    counters.filesExcluded = 2;
    expect(derivePartialSuccess(counters, true)).toBe(true);
  });

  it('flushes at most once per interval unless forced or batch-full', async () => {
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const counters = createIngestCounters();
    let now = 1_000;
    const flusher = createProgressFlusher({
      counters,
      saveProgress,
      now: () => now,
      flushIntervalMs: 2_000,
    });

    flusher.noteFileProcessed();
    await flusher.maybeFlush(false);
    expect(saveProgress).not.toHaveBeenCalled();

    now = 3_500;
    flusher.noteFileProcessed();
    await flusher.maybeFlush(false);
    expect(saveProgress).toHaveBeenCalledTimes(1);

    flusher.noteFileProcessed();
    await flusher.maybeFlush(false);
    expect(saveProgress).toHaveBeenCalledTimes(1);

    await flusher.flushNow();
    expect(saveProgress).toHaveBeenCalledTimes(2);

    for (let i = 0; i < INGEST_FILE_BATCH_SIZE; i += 1) {
      flusher.noteFileProcessed();
    }
    await flusher.maybeFlush(false);
    expect(saveProgress).toHaveBeenCalledTimes(3);
  });
});
