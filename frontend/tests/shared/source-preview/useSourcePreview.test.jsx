/**
 * Shared useSourcePreview hook tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSourcePreview } from '@/shared/source-preview';

const fetchSourceFileMetadata = vi.fn();
const fetchSourceSlice = vi.fn();

vi.mock('@/shared/source-preview/sourcePreviewApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchSourceFileMetadata: (...args) => fetchSourceFileMetadata(...args),
    fetchSourceSlice: (...args) => fetchSourceSlice(...args),
  };
});

/**
 * @param {import('react').ReactNode} children Tree.
 */
function wrapper({ children }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useSourcePreview', () => {
  it('stays disabled without a preview target', () => {
    const { result } = renderHook(() => useSourcePreview('p1', null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('loads metadata only when preview is unavailable', async () => {
    fetchSourceFileMetadata.mockResolvedValue({ previewAvailable: false });
    const { result } = renderHook(() => useSourcePreview('p1', { path: 'logo.png', startLine: 1, endLine: 2 }), { wrapper });
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
