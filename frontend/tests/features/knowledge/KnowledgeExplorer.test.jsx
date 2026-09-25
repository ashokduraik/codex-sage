/**
 * Knowledge explorer tests against mocked browse APIs.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('@tests/features/projects/test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

const fetchKnowledgeFacets = vi.fn();
const fetchKnowledgeHealth = vi.fn();
const fetchKnowledgeWorkflows = vi.fn();
const fetchKnowledgeSummary = vi.fn();
const fetchKnowledgeApis = vi.fn();
const fetchKnowledgeSymbols = vi.fn();
const fetchSourceFileMetadata = vi.fn();
const fetchSourceSlice = vi.fn();

vi.mock('@/features/knowledge/api/knowledgeApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchKnowledgeFacets: (...args) => fetchKnowledgeFacets(...args),
    fetchKnowledgeHealth: (...args) => fetchKnowledgeHealth(...args),
    fetchKnowledgeWorkflows: (...args) => fetchKnowledgeWorkflows(...args),
    fetchKnowledgeSummary: (...args) => fetchKnowledgeSummary(...args),
    fetchKnowledgeApis: (...args) => fetchKnowledgeApis(...args),
    fetchKnowledgeSymbols: (...args) => fetchKnowledgeSymbols(...args),
    fetchSourceFileMetadata: (...args) => fetchSourceFileMetadata(...args),
    fetchSourceSlice: (...args) => fetchSourceSlice(...args),
  };
});

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@tests/renderWithProviders';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';
import KnowledgeExplorer from '@/features/knowledge/KnowledgeExplorer';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  fetchKnowledgeFacets.mockReset();
  fetchKnowledgeHealth.mockReset();
  fetchKnowledgeWorkflows.mockReset();
  fetchKnowledgeSummary.mockReset();
  fetchKnowledgeApis.mockReset();
  fetchKnowledgeSymbols.mockReset();
  fetchSourceFileMetadata.mockReset();
  fetchSourceSlice.mockReset();
  fetchKnowledgeHealth.mockResolvedValue({
    state: 'ready',
    dimensions: { publishedHealth: { state: 'ready' } },
  });
});

/**
 * @param {string} route Location.
 */
async function renderExplorer(route) {
  const view = renderWithProviders(
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />}>
        <Route path="knowledge" element={<KnowledgeExplorer />} />
        <Route path="chat" element={<div>Chat page</div>} />
      </Route>
    </Routes>,
    { route },
  );
  await screen.findByRole('heading', { name: 'Knowledge' });
  return view;
}

describe('KnowledgeExplorer', () => {
  it('renders only facets returned by the API', async () => {
    fetchKnowledgeFacets.mockResolvedValue({
      state: 'ready',
      knowledgeVersionId: 'kv1',
      facets: [
        { key: 'workflows', available: true },
        { key: 'apis', available: true },
      ],
    });
    await renderExplorer('/projects/prj_atlas/knowledge');
    expect(await screen.findByRole('button', { name: 'Workflows' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'APIs' })).toBeTruthy();
    expect(screen.queryByText('Data')).toBeNull();
    expect(screen.queryByText('Authentication & Authorization')).toBeNull();
  });

  it('shows empty state when no facets are available', async () => {
    fetchKnowledgeFacets.mockResolvedValue({
      state: 'ready',
      knowledgeVersionId: 'kv1',
      facets: [],
    });
    await renderExplorer('/projects/prj_helios/knowledge');
    expect(await screen.findByText('No knowledge yet')).toBeTruthy();
  });

  it('surfaces an unavailable alert', async () => {
    fetchKnowledgeFacets.mockResolvedValue({
      state: 'unavailable',
      knowledgeVersionId: 'kv1',
      facets: [],
    });
    await renderExplorer('/projects/prj_atlas/knowledge');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/not available/i)).toBeTruthy();
  });

  it('expands documentation and opens a preview from a workflow', async () => {
    fetchKnowledgeFacets.mockResolvedValue({
      state: 'ready',
      knowledgeVersionId: 'kv1',
      facets: [
        { key: 'documentation', available: true },
        { key: 'workflows', available: true },
      ],
    });
    fetchKnowledgeSummary.mockResolvedValue({ summary: 'Refunds are async.' });
    fetchKnowledgeWorkflows.mockResolvedValue({
      state: 'ready',
      items: [{ id: 'wf1', title: 'Checkout', sourceRefs: [{ path: 'src/flow.js', startLine: 1 }] }],
    });
    fetchSourceFileMetadata.mockResolvedValue({
      path: 'src/flow.js',
      previewAvailable: true,
      excludedFromGraph: false,
    });
    fetchSourceSlice.mockResolvedValue({
      content: 'export function checkout() {}',
      startLine: 1,
      endLine: 1,
      truncated: false,
    });
    await renderExplorer('/projects/prj_atlas/knowledge');
    fireEvent.click(await screen.findByRole('button', { name: 'Documentation' }));
    expect(await screen.findByText('Refunds are async.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }));
    expect(await screen.findByText('Checkout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('export function checkout() {}')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  });

  it('surfaces an updating alert and expands a facet', async () => {
    fetchKnowledgeFacets.mockResolvedValue({
      state: 'updating',
      knowledgeVersionId: 'kv1',
      facets: [],
    });
    await renderExplorer('/projects/prj_atlas/knowledge');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/updating/i)).toBeTruthy();
  });

  it('surfaces a network error as an alert', async () => {
    fetchKnowledgeFacets.mockRejectedValue(new Error('network down'));
    await renderExplorer('/projects/prj_atlas/knowledge');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
  });

  it('shows empty facet copy and a facet error', async () => {
    fetchKnowledgeFacets.mockResolvedValue({
      state: 'ready',
      knowledgeVersionId: 'kv1',
      facets: [
        { key: 'documentation', available: true },
        { key: 'workflows', available: true },
        { key: 'apis', available: true },
      ],
    });
    fetchKnowledgeSummary.mockResolvedValue({ summary: '' });
    fetchKnowledgeWorkflows.mockResolvedValue({ items: [] });
    fetchKnowledgeApis.mockRejectedValue(new Error('facet failed'));
    await renderExplorer('/projects/prj_atlas/knowledge');
    fireEvent.click(await screen.findByRole('button', { name: 'Documentation' }));
    expect(await screen.findByText('Nothing in this category yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Workflows' }));
    await waitFor(() => {
      expect(screen.getAllByText('Nothing in this category yet.')).toHaveLength(2);
    });
    fireEvent.click(screen.getByRole('button', { name: 'APIs' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('facet failed')).toBeTruthy();
  });

  it('filters symbols and asks about an item without a source path', async () => {
    fetchKnowledgeFacets.mockResolvedValue({
      state: 'ready',
      knowledgeVersionId: 'kv1',
      facets: [{ key: 'symbols', available: true }],
    });
    fetchKnowledgeSymbols.mockResolvedValue({
      items: [{ id: 'sym1', name: 'refundHandler' }],
    });
    await renderExplorer('/projects/prj_atlas/knowledge');
    fireEvent.click(await screen.findByRole('button', { name: 'Symbols' }));
    const input = await screen.findByPlaceholderText('Search symbols…');
    fireEvent.change(input, { target: { value: 're' } });
    expect(await screen.findByText('refundHandler')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }));
    expect(await screen.findByText('Chat page')).toBeTruthy();
  });

  it('asks about a workflow without using the q query param', async () => {
    fetchKnowledgeFacets.mockResolvedValue({
      state: 'ready',
      knowledgeVersionId: 'kv1',
      facets: [{ key: 'workflows', available: true }],
    });
    fetchKnowledgeWorkflows.mockResolvedValue({
      state: 'ready',
      items: [{ id: 'wf1', title: 'Checkout', sourceRefs: [{ path: 'src/flow.js', startLine: 1 }] }],
    });
    await renderExplorer('/projects/prj_atlas/knowledge');
    fireEvent.click(await screen.findByRole('button', { name: 'Workflows' }));
    expect(await screen.findByText('Checkout')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }));
    expect(await screen.findByText('Chat page')).toBeTruthy();
    expect(window.location.search.includes('q=')).toBe(false);
  });
});
