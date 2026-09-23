/**
 * Hook tests for change summary and source preview.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const fetchChangeSummary = vi.fn();
const fetchSourceFileMetadata = vi.fn();
const fetchSourceSlice = vi.fn();

vi.mock('../api/changesApi.js', () => ({
  fetchChangeSummary: (...args) => fetchChangeSummary(...args),
}));

vi.mock('../api/previewApi.js', () => ({
  fetchSourceFileMetadata: (...args) => fetchSourceFileMetadata(...args),
  fetchSourceSlice: (...args) => fetchSourceSlice(...args),
}));

import { useChangeSummary } from './useChangeSummary.js';
import { useSourcePreview } from './useSourcePreview.js';

/**
 * @param {import('react').ReactNode} children Tree.
 */
function wrapper({ children }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useChangeSummary / useSourcePreview', () => {
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

  it('stays disabled without a preview target', () => {
    const { result } = renderHook(() => useSourcePreview('p1', null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('loads metadata only when preview is unavailable', async () => {
    fetchSourceFileMetadata.mockResolvedValue({ previewAvailable: false });
    const { result } = renderHook(
      () => useSourcePreview('p1', { path: 'logo.png', startLine: 1, endLine: 2 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.slice).toBeNull();
    expect(fetchSourceSlice).not.toHaveBeenCalled();
  });

  it('loads a slice when preview is available', async () => {
    fetchSourceFileMetadata.mockResolvedValue({ previewAvailable: true });
    fetchSourceSlice.mockResolvedValue({ content: 'hi' });
    const { result } = renderHook(() => useSourcePreview('p1', { path: 'a.js' }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.slice.content).toBe('hi');
  });
});
