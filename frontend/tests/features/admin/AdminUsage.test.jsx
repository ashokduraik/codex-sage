import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

vi.mock('@/features/admin/api/usageApi.js', () => ({
  organizationUsageQueryKey: (window = {}) => Object.freeze(['usage', 'organization', window.from ?? null, window.to ?? null]),
  fetchOrganizationUsage: vi.fn(),
}));

import AdminUsage from '@/features/admin/AdminUsage';
import { fetchOrganizationUsage } from '@/features/admin/api/usageApi.js';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession('you@acme.io', { permissions: ['usage.view'] });
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
  it('renders measured ingest and search totals and omits absent question tiles', async () => {
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
    expect(screen.queryByText('Tokens used')).toBeNull();
  });

  it('shows questions and tokens when the API returns those keys', async () => {
    fetchOrganizationUsage.mockResolvedValue({
      period: { from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' },
      totals: { questionsAnswered: 5, tokensInput: 100, tokensOutput: 40 },
      byProject: [],
      byUser: [{ userId: 'u1', questionsAnswered: 5, tokensInput: 100, tokensOutput: 40 }],
    });
    renderWithProviders(<AdminUsage />);
    expect(await screen.findByText('Questions asked')).toBeTruthy();
    expect(screen.getByText('Tokens used')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('140')).toBeTruthy();
    expect(screen.getByText('Usage by user')).toBeTruthy();
  });

  it('shows forbidden when the caller lacks usage.view', async () => {
    clearAuthSession();
    seedAuthSession('you@acme.io', { permissions: ['users.manage'] });
    renderWithProviders(<AdminUsage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetchOrganizationUsage).not.toHaveBeenCalled();
  });

  it('shows an empty state when no facts were recorded', async () => {
    fetchOrganizationUsage.mockResolvedValue({
      period: { from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' },
      totals: {},
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
      totals: { ingestJobsCompleted: 1 },
      byProject: [],
      byUser: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(fetchOrganizationUsage).toHaveBeenCalledTimes(2);
    });
  });
});
