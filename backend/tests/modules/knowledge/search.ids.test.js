/**
 * Unit tests for search result ids, snippets, and cursors.
 */
import { describe, expect, it } from 'vitest';
import { SEARCH_SNIPPET_MAX_CHARS } from '../../../src/modules/knowledge/search.js';
import {
  decodeOpaqueKey,
  encodeOpaqueKey,
  truncateSnippet,
  compareSearchItems,
  decodeSearchCursor,
  encodeSearchCursor,
  isAfterSearchCursor,
  parseSearchResultId,
  encodeSearchResultId,
} from '../../../src/modules/knowledge/search.js';

describe('search result ids', () => {
  it('round-trips version, type, and opaque key', () => {
    const id = encodeSearchResultId('kv1', 'symbol', 'src/a.js|refund|42');
    expect(parseSearchResultId(id)).toEqual({
      knowledgeVersionId: 'kv1',
      type: 'symbol',
      opaqueKey: 'src/a.js|refund|42',
    });
  });

  it('keeps colons inside the opaque key', () => {
    const id = encodeSearchResultId('kv1', 'api', 'POST:/refunds|src/a.js|3');
    expect(parseSearchResultId(id)?.opaqueKey).toBe('POST:/refunds|src/a.js|3');
  });

  it('returns null for malformed ids', () => {
    expect(parseSearchResultId('')).toBeNull();
    expect(parseSearchResultId(null)).toBeNull();
    expect(parseSearchResultId('only-one')).toBeNull();
    expect(parseSearchResultId(':symbol:x')).toBeNull();
    expect(parseSearchResultId('kv1::x')).toBeNull();
    expect(parseSearchResultId('kv1:symbol:')).toBeNull();
  });

  it('encodes and decodes opaque path parts', () => {
    const encoded = encodeOpaqueKey(['src/a.js', 'refundHandler', 42]);
    expect(decodeOpaqueKey(encoded)).toEqual(['src/a.js', 'refundHandler', '42']);
    expect(decodeOpaqueKey('')).toEqual([]);
    expect(decodeOpaqueKey('%E0%A4%A')).toEqual(['%E0%A4%A']);
  });
});

describe('snippets and cursors', () => {
  it('truncates long snippets and collapses whitespace', () => {
    expect(truncateSnippet('')).toBe('');
    expect(truncateSnippet(12)).toBe('');
    expect(truncateSnippet('  hello   world  ')).toBe('hello world');
    const long = 'x'.repeat(SEARCH_SNIPPET_MAX_CHARS + 20);
    expect(truncateSnippet(long)).toHaveLength(SEARCH_SNIPPET_MAX_CHARS);
  });

  it('encodes a cursor that pages after the last item', () => {
    const cursor = encodeSearchCursor({ type: 'doc', title: 'A', id: 'kv:doc:1' });
    const decoded = decodeSearchCursor(cursor);
    expect(decoded).toEqual({ type: 'doc', title: 'A', id: 'kv:doc:1' });
    expect(isAfterSearchCursor({ type: 'doc', title: 'B', id: 'kv:doc:2' }, decoded)).toBe(true);
    expect(isAfterSearchCursor({ type: 'doc', title: 'A', id: 'kv:doc:1' }, decoded)).toBe(false);
    expect(isAfterSearchCursor({ type: 'doc', title: 'B', id: 'x' }, null)).toBe(true);
  });

  it('returns null for invalid cursors', () => {
    expect(decodeSearchCursor('')).toBeNull();
    expect(decodeSearchCursor('%%%')).toBeNull();
    expect(decodeSearchCursor(Buffer.from('{}', 'utf8').toString('base64url'))).toBeNull();
  });

  it('sorts by type order then title then id', () => {
    expect(compareSearchItems({ type: 'code', title: 'b', id: '1' }, { type: 'doc', title: 'a', id: '2' })).toBeLessThan(0);
    expect(compareSearchItems({ type: 'doc', title: 'b', id: '1' }, { type: 'doc', title: 'a', id: '2' })).toBeGreaterThan(0);
    expect(compareSearchItems({ type: 'doc', title: 'a', id: '2' }, { type: 'doc', title: 'a', id: '1' })).toBeGreaterThan(0);
  });
});
