/**
 * Unit tests for path+sha256 source diff classification and carry derivation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceFile } from '../../../src/models/sourceFile.model.js';
import {
  SOURCE_DIFF_BATCH_SIZE,
  carryFromSourceDiff,
  classifySourceDiff,
  loadPathHashesForVersion,
} from '../../../src/modules/knowledge/sources.js';

describe('classifySourceDiff', () => {
  it('treats every incoming path as added when there is no prior version', () => {
    const incoming = new Map([
      ['README.md', 'aaa'],
      ['src/app.js', 'bbb'],
    ]);
    expect(classifySourceDiff(incoming, new Map())).toMatchObject({
      added: ['README.md', 'src/app.js'],
      counts: { added: 2, removed: 0, changed: 0, unchanged: 0 },
    });
    const result = classifySourceDiff(incoming, null);
    expect(result).toEqual({
      added: ['README.md', 'src/app.js'],
      removed: [],
      changed: [],
      unchanged: [],
      counts: { added: 2, removed: 0, changed: 0, unchanged: 0 },
    });
  });

  it('classifies added, removed, changed, and unchanged paths', () => {
    const incoming = new Map([
      ['README.md', 'same'],
      ['src/app.js', 'new-hash'],
      ['src/new.js', 'ccc'],
    ]);
    const published = new Map([
      ['README.md', 'same'],
      ['src/app.js', 'old-hash'],
      ['docs/old.md', 'ddd'],
    ]);
    const result = classifySourceDiff(incoming, published);
    expect(result.added).toEqual(['src/new.js']);
    expect(result.removed).toEqual(['docs/old.md']);
    expect(result.changed).toEqual(['src/app.js']);
    expect(result.unchanged).toEqual(['README.md']);
    expect(result.counts).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      unchanged: 1,
    });
  });
});

describe('carryFromSourceDiff', () => {
  it('derives skipPaths and changedPaths consistently from the diff', () => {
    const carry = carryFromSourceDiff({
      added: ['src/new.js'],
      removed: ['docs/old.md'],
      changed: ['src/app.js'],
      unchanged: ['README.md'],
      baseSourceVersionId: 'sv_base',
    });
    expect([...carry.skipPaths]).toEqual(['README.md']);
    expect(carry.changedPaths).toEqual(['src/app.js', 'src/new.js']);
    expect(carry.removedPaths).toEqual(['docs/old.md']);
    expect(carry.baseSourceVersionId).toBe('sv_base');
  });
});

describe('loadPathHashesForVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pages until a short batch and uses SOURCE_DIFF_BATCH_SIZE by default', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce([
        { path: 'a.js', sha256: '1' },
        { path: 'b.js', sha256: '2' },
      ])
      .mockResolvedValueOnce([{ path: 'c.js', sha256: '3' }]);
    const page = vi.spyOn(SourceFile, 'find').mockReturnValue({
      sort() {
        return this;
      },
      limit() {
        return this;
      },
      lean() {
        return this;
      },
      exec,
    });

    const byPath = await loadPathHashesForVersion({
      orgId: 'o',
      projectId: 'p',
      sourceVersionId: '665f1c9d4b2a8e0012a4f012',
      batchSize: 2,
    });
    expect(byPath.get('c.js')).toBe('3');
    expect(page).toHaveBeenCalledTimes(2);
    expect(SOURCE_DIFF_BATCH_SIZE).toBe(500);
  });

  it('stops immediately on an empty first page', async () => {
    vi.spyOn(SourceFile, 'find').mockReturnValue({
      sort() {
        return this;
      },
      limit() {
        return this;
      },
      lean() {
        return this;
      },
      exec: vi.fn().mockResolvedValue([]),
    });
    const byPath = await loadPathHashesForVersion({
      orgId: 'o',
      projectId: 'p',
      sourceVersionId: '665f1c9d4b2a8e0012a4f012',
    });
    expect(byPath.size).toBe(0);
  });
});
