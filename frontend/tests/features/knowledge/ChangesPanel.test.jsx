/**
 * Changes panel tests against the mocked change-summary API.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/projects/api/projectsApi.js', async () => {
  const fixtures = await import('@tests/features/projects/test/projectApiFixtures.js');
  return fixtures.defaultProjectsApiMock;
});

const fetchChangeSummary = vi.fn();
const fetchSourceFileMetadata = vi.fn();
const fetchSourceSlice = vi.fn();

vi.mock('@/features/knowledge/api/knowledgeApi.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchChangeSummary: (...args) => fetchChangeSummary(...args),
    fetchSourceFileMetadata: (...args) => fetchSourceFileMetadata(...args),
    fetchSourceSlice: (...args) => fetchSourceSlice(...args),
  };
});

import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';
import ChangesPanel from '@/features/knowledge/ChangesPanel';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  fetchChangeSummary.mockReset();
  fetchSourceFileMetadata.mockReset();
  fetchSourceSlice.mockReset();
});

/**
 * @param {string} route Location.
 */
function renderChanges(route) {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />}>
        <Route path="changes" element={<ChangesPanel />} />
      </Route>
    </Routes>,
    { route },
  );
}

describe('ChangesPanel', () => {
  it('renders API counts and hides null impact', async () => {
    fetchChangeSummary.mockResolvedValue({
      counts: { added: 1, modified: 2, removed: 0 },
      impact: { apisChanged: null, workflowsChanged: null, documentationConflicts: 0 },
      paths: {
        added: [{ path: 'src/payments/refund.js', impact: 'Touches checkout' }],
        modified: [{ path: 'src/app.js', impact: null }],
        removed: [],
      },
      conflicts: [],
    });
    renderChanges('/projects/prj_atlas/changes');
    expect(await screen.findByRole('heading', { name: 'Changes' })).toBeTruthy();
    expect(screen.getByText('src/payments/refund.js')).toBeTruthy();
    expect(screen.getByText('Touches checkout')).toBeTruthy();
    expect(screen.queryByText('APIs / workflows affected')).toBeNull();
    expect(screen.getByText('No documentation conflicts were recorded for this update.')).toBeTruthy();
    fetchSourceFileMetadata.mockResolvedValue({
      path: 'src/payments/refund.js',
      previewAvailable: true,
      excludedFromGraph: false,
    });
    fetchSourceSlice.mockResolvedValue({
      content: 'export function refund() {}',
      startLine: 1,
      endLine: 40,
      truncated: false,
    });
    fireEvent.click(screen.getByText('src/payments/refund.js'));
    expect(await screen.findByText('export function refund() {}')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  });

  it('shows empty state when no summary exists', async () => {
    fetchChangeSummary.mockResolvedValue(null);
    renderChanges('/projects/prj_helios/changes');
    expect(await screen.findByText('No recent changes')).toBeTruthy();
  });

  it('shows a network error as an alert', async () => {
    fetchChangeSummary.mockRejectedValue(new Error('network down'));
    renderChanges('/projects/prj_atlas/changes');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('network down')).toBeTruthy();
  });

  it('toggles a conflict when the API returns one', async () => {
    fetchChangeSummary.mockResolvedValue({
      counts: { added: 0, modified: 0, removed: 0 },
      impact: { apisChanged: 1, workflowsChanged: null, documentationConflicts: 1 },
      paths: { added: [], modified: [], removed: [] },
      conflicts: [
        {
          concept: 'Checkout confirmation',
          code: { excerpt: 'async queue' },
          documentation: { excerpt: 'sync confirm' },
        },
      ],
    });
    renderChanges('/projects/prj_atlas/changes');
    expect(await screen.findByText('Checkout confirmation')).toBeTruthy();
    expect(screen.getByText(/APIs \/ workflows affected/)).toBeTruthy();
    fireEvent.click(screen.getByText('Checkout confirmation'));
    expect(screen.getByText('Code says')).toBeTruthy();
    expect(screen.getByText('async queue')).toBeTruthy();
    fireEvent.click(screen.getByText('Checkout confirmation'));
    expect(screen.queryByText('Code says')).toBeNull();
  });

  it('renders string conflict excerpts when objects are omitted', async () => {
    fetchChangeSummary.mockResolvedValue({
      counts: { added: 0, modified: 0, removed: 0 },
      impact: { apisChanged: 0, workflowsChanged: 2, documentationConflicts: 1 },
      paths: { added: [], modified: [], removed: [] },
      conflicts: [{ concept: 'Refunds', code: 'queue job', docs: 'sync refund' }],
    });
    renderChanges('/projects/prj_atlas/changes');
    fireEvent.click(await screen.findByText('Refunds'));
    expect(screen.getByText('queue job')).toBeTruthy();
    expect(screen.getByText('sync refund')).toBeTruthy();
  });
});
