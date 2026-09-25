/**
 * Hook tests for knowledge queries.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const fetchKnowledgeFacets = vi.fn();
const fetchKnowledgeHealth = vi.fn();
const fetchKnowledgeSummary = vi.fn();
const fetchKnowledgeWorkflows = vi.fn();
const fetchKnowledgeApis = vi.fn();
const fetchKnowledgeSymbols = vi.fn();

vi.mock('@/features/knowledge/api/knowledgeApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchKnowledgeFacets: (...args) => fetchKnowledgeFacets(...args),
    fetchKnowledgeHealth: (...args) => fetchKnowledgeHealth(...args),
    fetchKnowledgeSummary: (...args) => fetchKnowledgeSummary(...args),
    fetchKnowledgeWorkflows: (...args) => fetchKnowledgeWorkflows(...args),
    fetchKnowledgeApis: (...args) => fetchKnowledgeApis(...args),
    fetchKnowledgeSymbols: (...args) => fetchKnowledgeSymbols(...args),
  };
});

import { useKnowledgeFacet, useKnowledgeFacets, useKnowledgeHealth } from '@/features/knowledge/hooks/useKnowledgeFacets.js';

/**
 * @param {import('react').ReactNode} children Tree.
 */
function wrapper({ children }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('knowledge hooks', () => {
  it('loads facets and health when a project id is present', async () => {
    fetchKnowledgeFacets.mockResolvedValue({ state: 'ready', facets: [] });
    fetchKnowledgeHealth.mockResolvedValue({ state: 'ready' });
    const facets = renderHook(() => useKnowledgeFacets('p1'), { wrapper });
    const health = renderHook(() => useKnowledgeHealth('p1'), { wrapper });
    await waitFor(() => expect(facets.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(health.result.current.isSuccess).toBe(true));
    expect(fetchKnowledgeFacets).toHaveBeenCalled();
  });

  it('stays disabled without a project id', () => {
    const facets = renderHook(() => useKnowledgeFacets(''), { wrapper });
    const health = renderHook(() => useKnowledgeHealth('', { enabled: false }), { wrapper });
    const facet = renderHook(() => useKnowledgeFacet('', null, { enabled: false }), { wrapper });
    expect(facets.result.current.fetchStatus).toBe('idle');
    expect(health.result.current.fetchStatus).toBe('idle');
    expect(facet.result.current.fetchStatus).toBe('idle');
  });

  it('loads summary for documentation and summary kinds', async () => {
    fetchKnowledgeSummary.mockResolvedValue({ summary: 'Hello' });
    const { result } = renderHook(() => useKnowledgeFacet('p1', 'documentation', { enabled: true }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.summary).toBe('Hello');
    const summary = renderHook(() => useKnowledgeFacet('p1', 'summary', { enabled: true }), {
      wrapper,
    });
    await waitFor(() => expect(summary.result.current.isSuccess).toBe(true));
  });

  it('loads workflows, apis, and symbols by kind', async () => {
    fetchKnowledgeWorkflows.mockResolvedValue({ items: [] });
    fetchKnowledgeApis.mockResolvedValue({ items: [] });
    fetchKnowledgeSymbols.mockResolvedValue({ items: [] });
    const workflows = renderHook(() => useKnowledgeFacet('p1', 'workflows', { enabled: true }), {
      wrapper,
    });
    const apis = renderHook(() => useKnowledgeFacet('p1', 'apis', { enabled: true }), { wrapper });
    const symbols = renderHook(() => useKnowledgeFacet('p1', 'symbols', { q: 're', enabled: true }), {
      wrapper,
    });
    await waitFor(() => expect(workflows.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(apis.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(symbols.result.current.isSuccess).toBe(true));
    expect(fetchKnowledgeSymbols).toHaveBeenCalled();
  });
});
