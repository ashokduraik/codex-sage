/**
 * Unit tests for archive root-prefix stripping.
 */
import { describe, expect, it } from 'vitest';
import { createArchiveRootRewriter } from './archiveRoot.js';

describe('createArchiveRootRewriter', () => {
  it('strips a shared first segment when nested files exist', () => {
    const rewrite = createArchiveRootRewriter([
      'payments-abc/src/a.js',
      'payments-abc/README.md',
    ]);
    expect(rewrite('payments-abc/src/a.js')).toBe('src/a.js');
    expect(rewrite('payments-abc/README.md')).toBe('README.md');
  });

  it('leaves paths unchanged when there is no shared nested root', () => {
    const mixed = createArchiveRootRewriter(['src/a.js', 'docs/b.md']);
    expect(mixed('src/a.js')).toBe('src/a.js');

    const flat = createArchiveRootRewriter(['README.md']);
    expect(flat('README.md')).toBe('README.md');

    const empty = createArchiveRootRewriter([]);
    expect(empty('src/a.js')).toBe('src/a.js');
  });
});
