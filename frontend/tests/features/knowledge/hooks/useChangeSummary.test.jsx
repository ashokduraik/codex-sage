/**
 * Hook tests for knowledge change summary.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChangeSummary } from '@/features/knowledge/hooks/useChangeSummary.js';

const fetchChangeSummary = vi.fn();

vi.mock('@/features/knowledge/api/knowledgeApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchChangeSummary: (...args) => fetchChangeSummary(...args),
  };
});

/**
 * @param {import('react').ReactNode} children Tree.
 */
function wrapper({ children }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useChangeSummary', () => {
  it('stays disabled without a project id', () => {
    const { result } = renderHook(() => useChangeSummary(''), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('loads a change summary', async () => {
    fetchChangeSummary.mockResolvedValue({ counts: { added: 1 } });
    const { result } = renderHook(() => useChangeSummary('p1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.counts.added).toBe(1);
  });
});
