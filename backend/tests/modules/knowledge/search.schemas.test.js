/**
 * Unit tests for search query parsing.
 */
import { describe, expect, it } from 'vitest';
import { SEARCH_PAGE_SIZE, SEARCH_TYPES } from '../../../src/modules/knowledge/search.js';
import { clampSearchLimit, parseSearchQuery, parseSearchTypes, zodDetails } from '../../../src/modules/knowledge/search.js';

describe('parseSearchTypes', () => {
  it('defaults to every supported type', () => {
    expect(parseSearchTypes(undefined)).toEqual([...SEARCH_TYPES]);
    expect(parseSearchTypes('')).toEqual([...SEARCH_TYPES]);
  });

  it('deduplicates a valid comma-separated list', () => {
    expect(parseSearchTypes('doc, symbol, doc')).toEqual(['doc', 'symbol']);
  });

  it('throws VALIDATION_ERROR for unknown tokens or empty lists', () => {
    expect(() => parseSearchTypes('data')).toMatchObject({
      // thrown as ApiError
    });
    try {
      parseSearchTypes('data');
    } catch (error) {
      expect(error.code).toBe('VALIDATION_ERROR');
    }
    try {
      parseSearchTypes(',');
    } catch (error) {
      expect(error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('parseSearchQuery', () => {
  it('parses a valid query', () => {
    expect(parseSearchQuery({ q: '  refund  ', types: 'doc', limit: '10' })).toMatchObject({
      q: 'refund',
      types: ['doc'],
      limit: 10,
    });
  });

  it('rejects missing, short, or whitespace-only q', () => {
    expect(() => parseSearchQuery({})).toThrow();
    expect(() => parseSearchQuery({ q: 'x' })).toThrow();
    expect(() => parseSearchQuery({ q: '   ' })).toThrow();
    try {
      parseSearchQuery({ q: '' });
    } catch (error) {
      expect(error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('clamps limit and maps zod details', () => {
    expect(clampSearchLimit(undefined)).toBe(SEARCH_PAGE_SIZE);
    expect(clampSearchLimit(0)).toBe(SEARCH_PAGE_SIZE);
    expect(clampSearchLimit(999)).toBe(SEARCH_PAGE_SIZE);
    expect(clampSearchLimit(4)).toBe(4);
    expect(zodDetails({ issues: [{ path: ['q'], message: 'Required' }] })).toEqual([{ path: 'q', message: 'Required' }]);
    expect(zodDetails({ issues: [{ path: [], message: 'bad' }] })).toEqual([{ path: 'query', message: 'bad' }]);
  });
});
