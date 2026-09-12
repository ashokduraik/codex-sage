/**
 * Unit tests for S2 exclude_apply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSourceFilesOrdered = vi.fn();
const updateSourceFileExclusion = vi.fn();

vi.mock('../ingest.repository.js', async () => {
  const actual = await vi.importActual('../ingest.repository.js');
  return {
    ...actual,
    listSourceFilesOrdered: (...args) => listSourceFilesOrdered(...args),
    updateSourceFileExclusion: (...args) => updateSourceFileExclusion(...args),
  };
});

const { runExcludeApplyStage } = await import('./s2ExcludeApply.js');

describe('runExcludeApplyStage', () => {
  beforeEach(() => {
    listSourceFilesOrdered.mockReset();
    updateSourceFileExclusion.mockReset().mockResolvedValue(undefined);
  });

  it('records file_too_large exclusions and emits an event', async () => {
    listSourceFilesOrdered.mockResolvedValue([
      {
        _id: '1',
        path: 'src/big.js',
        byteLength: 2_000_000,
        fileState: 'stored',
        excludedFromGraph: false,
        exclusionReason: null,
      },
      {
        _id: '2',
        path: 'src/ok.js',
        byteLength: 10,
        fileState: 'stored',
        excludedFromGraph: false,
        exclusionReason: null,
      },
      {
        _id: '3',
        path: 'src/missing.js',
        byteLength: 10,
        fileState: 'missing',
        excludedFromGraph: false,
        exclusionReason: null,
      },
    ]);

    const ctx = {
      carry: { sourceVersion: { exclusionRulesetId: 'exclusions.v1' } },
      scope: { orgId: 'o', projectId: 'p', sourceVersionId: 'v' },
      counters: {
        filesProcessed: 3,
        filesFailed: 0,
        filesExcluded: 0,
        excludedByReason: {},
      },
      signal: { aborted: false },
      isCancelRequested: vi.fn().mockResolvedValue(false),
      noteFileProcessed: vi.fn(),
      saveProgress: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runExcludeApplyStage(ctx);
    expect(result.outcome).toBe('completed');
    expect(ctx.counters.filesExcluded).toBe(1);
    expect(ctx.counters.excludedByReason.file_too_large).toBe(1);
    expect(updateSourceFileExclusion).toHaveBeenCalledWith(
      expect.objectContaining({
        excludedFromGraph: true,
        exclusionReason: 'file_too_large',
      }),
    );
    expect(ctx.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'source.exclusions_applied' }),
    );
  });

  it('fails permanent when the recorded ruleset is unknown', async () => {
    await expect(
      runExcludeApplyStage({
        carry: { sourceVersion: { exclusionRulesetId: 'exclusions.v999' } },
        scope: {},
        counters: { excludedByReason: {} },
        emitEvent: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: 'SOURCE_UNKNOWN_EXCLUSION_RULESET',
      failureClass: 'permanent',
    });
  });
});
