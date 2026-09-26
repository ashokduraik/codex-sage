import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

vi.mock('@/features/admin/api/usageApi.js', () => ({
  organizationUsageQueryKey: () => Object.freeze(['usage', 'organization']),
  fetchOrganizationUsage: vi.fn(),
}));

import { fetchOrganizationUsage } from '@/features/admin/api/usageApi.js';
import AdminUsage from '@/features/admin/AdminUsage';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
  fetchOrganizationUsage.mockReset();
  if (typeof window.ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      constructor(_callback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    window.ResizeObserver = ResizeObserverStub;
  }
});

describe('AdminUsage', () => {
  it('renders measured ingest and search totals', async () => {
    fetchOrganizationUsage.mockResolvedValue({
      period: { from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' },
      totals: { ingestJobsCompleted: 3, sourceBytesAccepted: 1200, searchesExecuted: 8 },
      byProject: [
        {
          projectId: '507f1f77bcf86cd799439011',
          ingestJobsCompleted: 3,
          sourceBytesAccepted: 1200,
          searchesExecuted: 8,
        },
      ],
      byUser: [],
    });
    renderWithProviders(<AdminUsage />);
    expect(await screen.findByRole('heading', { name: 'Usage' })).toBeTruthy();
    expect(await screen.findByText('Ingest jobs completed')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('1,200')).toBeTruthy();
    expect(screen.getByText('By project')).toBeTruthy();
    expect(screen.queryByText('Questions asked')).toBeNull();
  });

  it('shows an empty state when no facts were recorded', async () => {
    fetchOrganizationUsage.mockResolvedValue({
      period: { from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' },
      totals: { ingestJobsCompleted: 0, sourceBytesAccepted: 0, searchesExecuted: 0 },
      byProject: [],
      byUser: [],
    });
    renderWithProviders(<AdminUsage />);
    expect(await screen.findByText('No measured usage in this period.')).toBeTruthy();
  });

  it('shows a retryable error when the API fails', async () => {
    fetchOrganizationUsage.mockRejectedValue(new Error('down'));
    renderWithProviders(<AdminUsage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    fetchOrganizationUsage.mockResolvedValue({
      period: { from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' },
      totals: { ingestJobsCompleted: 1, sourceBytesAccepted: 0, searchesExecuted: 0 },
      byProject: [],
      byUser: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(fetchOrganizationUsage).toHaveBeenCalledTimes(2);
    });
  });
});
