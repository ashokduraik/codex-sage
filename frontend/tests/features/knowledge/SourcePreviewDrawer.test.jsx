/**
 * Source preview drawer tests.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSourceFileMetadata = vi.fn();
const fetchSourceSlice = vi.fn();

vi.mock('@/features/knowledge/api/knowledgeApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchSourceFileMetadata: (...args) => fetchSourceFileMetadata(...args),
    fetchSourceSlice: (...args) => fetchSourceSlice(...args),
  };
});

import { renderWithProviders } from '@tests/renderWithProviders';
import SourcePreviewDrawer from '@/features/knowledge/SourcePreviewDrawer.jsx';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  fetchSourceFileMetadata.mockReset();
  fetchSourceSlice.mockReset();
});

describe('SourcePreviewDrawer', () => {
  it('shows excluded and truncated banners', async () => {
    fetchSourceFileMetadata.mockResolvedValue({
      path: 'src/a.js',
      previewAvailable: true,
      excludedFromGraph: true,
    });
    fetchSourceSlice.mockResolvedValue({
      content: 'hello',
      startLine: 1,
      endLine: 2,
      truncated: true,
    });
    renderWithProviders(<SourcePreviewDrawer projectId="p1" target={{ path: 'src/a.js', startLine: 1, endLine: 2 }} onClose={() => {}} />);
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(screen.getByText('This file is not in the code map. Chat will not treat it as graph knowledge.')).toBeTruthy();
    expect(screen.getByText('Preview was truncated to stay within the size limit.')).toBeTruthy();
  });

  it('shows a preview error as an alert', async () => {
    fetchSourceFileMetadata.mockRejectedValue(new Error('network down'));
    renderWithProviders(<SourcePreviewDrawer projectId="p1" target={{ path: 'src/a.js' }} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
  });

  it('shows binary copy when preview is unavailable', async () => {
    fetchSourceFileMetadata.mockResolvedValue({
      path: 'logo.png',
      previewAvailable: false,
      excludedFromGraph: false,
    });
    renderWithProviders(<SourcePreviewDrawer projectId="p1" target={{ path: 'logo.png' }} onClose={() => {}} />);
    expect(await screen.findByText('This file cannot be shown as text.')).toBeTruthy();
    expect(fetchSourceSlice).not.toHaveBeenCalled();
  });
});
