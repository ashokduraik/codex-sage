/**
 * Hook tests for debounced project search.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useProjectSearch } from '@/features/knowledge/hooks/useProjectSearch.js';

const fetchProjectSearch = vi.fn();

vi.mock('@/features/knowledge/api/knowledgeApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    KNOWLEDGE_SEARCH_DEBOUNCE_MS: 0,
    fetchProjectSearch: (...args) => fetchProjectSearch(...args),
  };
});

/**
 * @param {import('react').ReactNode} children Tree.
 */
function wrapper({ children }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useProjectSearch', () => {
  it('stays disabled without a project id', async () => {
    const { result } = renderHook(() => useProjectSearch('', 'refund', ''), { wrapper });
    await waitFor(() => expect(result.current.debouncedQ).toBe('refund'));
    expect(fetchProjectSearch).not.toHaveBeenCalled();
  });

  it('does not fetch a short query', async () => {
    const { result } = renderHook(() => useProjectSearch('p1', 'x', ''), { wrapper });
    await waitFor(() => expect(result.current.debouncedQ).toBe('x'));
    expect(fetchProjectSearch).not.toHaveBeenCalled();
  });

  it('fetches after debounce when the query is long enough', async () => {
    fetchProjectSearch.mockResolvedValue({ state: 'ready', items: [] });
    const { result } = renderHook(() => useProjectSearch('p1', 'refund', 'doc'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchProjectSearch).toHaveBeenCalled();
  });
});
