/**
 * Search panel tests against the mocked search API.
 */
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('@tests/features/projects/test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

import SearchPanel from '@/features/knowledge/SearchPanel';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

const fetchProjectSearch = vi.fn();
const fetchSourceFileMetadata = vi.fn();
const fetchSourceSlice = vi.fn();

vi.mock('@/features/knowledge/api/knowledgeApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    KNOWLEDGE_SEARCH_DEBOUNCE_MS: 0,
    fetchProjectSearch: (...args) => fetchProjectSearch(...args),
    fetchSourceFileMetadata: (...args) => fetchSourceFileMetadata(...args),
    fetchSourceSlice: (...args) => fetchSourceSlice(...args),
  };
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  fetchProjectSearch.mockReset();
  fetchSourceFileMetadata.mockReset();
  fetchSourceSlice.mockReset();
});

/**
 * @param {string} route Location.
 */
async function renderSearch(route) {
  const view = renderWithProviders(
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />}>
        <Route path="search" element={<SearchPanel />} />
        <Route path="chat" element={<div>Chat page</div>} />
      </Route>
    </Routes>,
    { route },
  );
  await screen.findByRole('heading', { name: 'Search' });
  return view;
}

describe('SearchPanel', () => {
  it('does not search until the query is long enough', async () => {
    await renderSearch('/projects/prj_atlas/search');
    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'x' },
    });
    await waitFor(() => {
      expect(fetchProjectSearch).not.toHaveBeenCalled();
    });
  });

  it('renders typed results and hides the Data chip', async () => {
    fetchProjectSearch.mockResolvedValue({
      state: 'ready',
      knowledgeVersionId: 'kv1',
      items: [
        {
          id: 'kv1:symbol:refund',
          type: 'symbol',
          title: 'refundHandler',
          snippet: 'async function refundHandler',
          sourceRef: { path: 'src/payments/refund.js', startLine: 2, endLine: 8 },
        },
      ],
    });
    await renderSearch('/projects/prj_atlas/search');
    expect(screen.queryByRole('button', { name: 'Data' })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'refund' },
    });
    expect(await screen.findByText('refundHandler')).toBeTruthy();
    expect(screen.getAllByText('Functionality').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Documentation' }));
    expect(await screen.findByText('refundHandler')).toBeTruthy();
  });

  it('opens a preview and navigates Ask about this without q=', async () => {
    fetchProjectSearch.mockResolvedValue({
      state: 'ready',
      knowledgeVersionId: 'kv1',
      items: [
        {
          id: 'kv1:symbol:refund',
          type: 'symbol',
          title: 'refundHandler',
          snippet: 'fn',
          sourceRef: { path: 'src/payments/refund.js', startLine: 2, endLine: 4 },
        },
      ],
    });
    fetchSourceFileMetadata.mockResolvedValue({
      path: 'src/payments/refund.js',
      previewAvailable: true,
      excludedFromGraph: false,
    });
    fetchSourceSlice.mockResolvedValue({
      content: 'async function refundHandler() {}',
      startLine: 2,
      endLine: 4,
      truncated: false,
    });
    await renderSearch('/projects/prj_atlas/search');
    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'refund' },
    });
    expect(await screen.findByText('refundHandler')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('async function refundHandler() {}')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Ask about this' }));
    expect(await screen.findByText('Chat page')).toBeTruthy();
    expect(window.location.search.includes('q=')).toBe(false);
  });

  it('shows a fallback search error when the rejection has no message', async () => {
    fetchProjectSearch.mockRejectedValue(new Error(''));
    await renderSearch('/projects/prj_atlas/search');
    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'refund' },
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Search could not be completed.')).toBeTruthy();
  });

  it('shows a network error as an alert', async () => {
    fetchProjectSearch.mockRejectedValue(new Error('network down'));
    await renderSearch('/projects/prj_atlas/search');
    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'refund' },
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
  });

  it('shows an unavailable alert and results without a file path', async () => {
    fetchProjectSearch.mockResolvedValue({
      state: 'unavailable',
      knowledgeVersionId: 'kv1',
      items: [{ id: 'kv1:workflow:x', type: 'other', title: 'Mystery', snippet: '' }],
    });
    await renderSearch('/projects/prj_atlas/search');
    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'mystery' },
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/not available/i)).toBeTruthy();
    expect(screen.getByText('Mystery')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('shows an alert when search is updating', async () => {
    fetchProjectSearch.mockResolvedValue({
      state: 'updating',
      knowledgeVersionId: 'kv1',
      items: [],
    });
    await renderSearch('/projects/prj_atlas/search');
    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'refund' },
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
