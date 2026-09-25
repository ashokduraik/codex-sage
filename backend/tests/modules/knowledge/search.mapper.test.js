/**
 * Unit tests for search item mapping.
 */
import { describe, expect, it } from 'vitest';
import {
  isFileLikeNode,
  mapApiSearchItem,
  mapDocSearchItem,
  mapGraphSearchItem,
  mapWorkflowSearchItem,
  matchesQueryText,
  toResolverEvidence,
  unwrapGraphNode,
} from '../../../src/modules/knowledge/search.js';

describe('search.mapper', () => {
  it('maps a document section to a typed search item', () => {
    const item = mapDocSearchItem(
      {
        _id: 'sec1',
        path: 'docs/refunds.md',
        heading: 'Refund policy',
        text: 'Partial refunds are allowed.',
        startLine: 3,
        endLine: 8,
      },
      'kv1',
    );
    expect(item).toMatchObject({
      id: 'kv1:doc:sec1',
      type: 'doc',
      title: 'Refund policy',
      score: null,
      sourceRef: { path: 'docs/refunds.md', sectionId: 'sec1', startLine: 3, endLine: 8 },
    });
    expect(mapDocSearchItem({}, 'kv1')).toBeNull();
    expect(mapDocSearchItem({ _id: 'x', path: 'a.md', heading: '  ', text: 'body' }, 'kv1').title).toBe(
      'a.md',
    );
  });

  it('maps symbol and file-like graph nodes', () => {
    const symbol = mapGraphSearchItem(
      { name: 'refundHandler', filePath: 'src/a.js', startLine: 42, endLine: 45, kind: 'function' },
      'kv1',
      'symbol',
    );
    expect(symbol?.type).toBe('symbol');
    expect(symbol?.title).toBe('refundHandler');
    expect(symbol?.sourceRef).toEqual({ path: 'src/a.js', startLine: 42, endLine: 45 });

    const nested = mapGraphSearchItem(
      { node: { name: 'a.js', filePath: 'src/a.js', startLine: 1, kind: 'file' }, snippet: 'export' },
      'kv1',
      'code',
    );
    expect(nested?.type).toBe('code');
    expect(nested?.snippet).toBe('export');
    expect(isFileLikeNode(unwrapGraphNode({ node: { kind: 'file' } }))).toBe(true);
    expect(isFileLikeNode(unwrapGraphNode({ kind: 'function' }))).toBe(false);
    expect(unwrapGraphNode(null)).toBeNull();
    expect(mapGraphSearchItem({ name: 'x' }, 'kv1', 'symbol')).toBeNull();
  });

  it('maps API and workflow rows and filters by query text', () => {
    const api = mapApiSearchItem(
      { url: '/refunds', handler: 'refundHandler', handlerFile: 'src/a.js', handlerLine: 10 },
      'kv1',
      0,
    );
    expect(api?.type).toBe('api');
    expect(api?.title).toBe('/refunds');

    const routeNode = mapApiSearchItem(
      { name: 'createRefund', filePath: 'src/routes.js', startLine: 2 },
      'kv1',
      1,
    );
    expect(routeNode?.title).toBe('createRefund');
    expect(mapApiSearchItem({}, 'kv1', 0)).toBeNull();

    const workflow = mapWorkflowSearchItem(
      { title: 'Checkout', path: 'src/flow.js', description: 'Place order', startLine: 1 },
      'kv1',
      0,
    );
    expect(workflow?.type).toBe('workflow');
    expect(mapWorkflowSearchItem({ name: 'Pay', filePath: 'src/p.js' }, 'kv1', 1)?.title).toBe('Pay');
    expect(mapWorkflowSearchItem({}, 'kv1', 0)).toBeNull();

    expect(matchesQueryText({ title: 'Refund Handler' }, 'refund')).toBe(true);
    expect(matchesQueryText({ url: '/orders' }, 'refund')).toBe(false);
    expect(toResolverEvidence(api)).toMatchObject({
      type: 'api',
      title: '/refunds',
      excerpt: 'refundHandler',
    });
  });
});
