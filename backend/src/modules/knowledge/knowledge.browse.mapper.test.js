/**
 * Unit tests for knowledge browse DTO mapping.
 */
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_SUMMARY_MAX_CHARS } from './knowledge.constants.js';
import {
  buildExtractiveSummary,
  capSummaryText,
  emptyBrowseEnvelope,
  mapApiItem,
  mapBrowseFacets,
  mapHealthDimensions,
  mapSymbolItem,
} from './knowledge.browse.mapper.js';

describe('knowledge.browse.mapper', () => {
  it('omits empty facet categories', () => {
    expect(mapBrowseFacets({ hasSummary: true, hasApis: false, hasSymbols: true })).toEqual([
      { key: 'summary', available: true },
      { key: 'symbols', available: true },
    ]);
    expect(
      mapBrowseFacets({
        hasSummary: true,
        hasWorkflows: true,
        hasApis: true,
        hasSymbols: true,
        hasDocumentation: true,
      }).map((facet) => facet.key),
    ).toEqual(['summary', 'workflows', 'apis', 'symbols', 'documentation']);
    expect(mapBrowseFacets({})).toEqual([]);
  });

  it('maps symbol nodes and search hits', () => {
    expect(
      mapSymbolItem({
        id: 'n1',
        name: 'refund',
        kind: 'function',
        filePath: 'src/pay.js',
        startLine: 4,
        endLine: 10,
      }),
    ).toMatchObject({
      id: 'n1',
      name: 'refund',
      path: 'src/pay.js',
      line: 4,
    });
    expect(
      mapSymbolItem({
        node: { name: 'nested', filePath: 'a.js', startLine: 1 },
      }),
    ).toMatchObject({ name: 'nested', path: 'a.js' });
    expect(mapSymbolItem({})).toBeNull();
    expect(mapSymbolItem({ name: 'x' })).toBeNull();
    expect(mapSymbolItem(null)).toBeNull();
    expect(capSummaryText('')).toBe('');
    expect(capSummaryText(null)).toBe('');
    expect(mapApiItem(null, 0)).toBeNull();
  });

  it('maps routing entries and route nodes', () => {
    expect(
      mapApiItem({ url: '/pay', handler: 'pay', handlerFile: 'r.js', handlerLine: 3 }, 0),
    ).toMatchObject({ title: '/pay', description: 'pay' });
    expect(
      mapApiItem({ id: 'r1', name: 'route', filePath: 'app.js', startLine: 2 }, 1),
    ).toMatchObject({ title: 'route' });
    expect(mapApiItem({}, 0)).toBeNull();
  });

  it('caps extractive summaries and includes docs plus graph metadata', () => {
    expect(capSummaryText('abc')).toBe('abc');
    expect(capSummaryText('x'.repeat(KNOWLEDGE_SUMMARY_MAX_CHARS + 10))).toHaveLength(
      KNOWLEDGE_SUMMARY_MAX_CHARS,
    );
    const summary = buildExtractiveSummary({
      projectName: 'Atlas',
      stats: { fileCount: 2, nodeCount: 9 },
      frameworks: ['express'],
      sections: [{ heading: 'Intro', text: 'Checkout flow.' }],
    });
    expect(summary).toContain('Atlas');
    expect(summary).toContain('Checkout flow.');
    expect(summary).toContain('Detected: express');
  });

  it('keeps health dimensions honest', () => {
    expect(
      mapHealthDimensions({
        hasSource: true,
        publishedHealth: 'partially_available',
        excludedFromGraphCount: 3,
      }),
    ).toMatchObject({
      sourceCode: { state: 'present' },
      publishedHealth: { state: 'partially_available' },
      exclusions: { state: 'partial' },
    });
    expect(emptyBrowseEnvelope('updating').items).toEqual([]);
  });
});
