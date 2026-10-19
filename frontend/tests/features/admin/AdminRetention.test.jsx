/**
 * AdminRetention — permission gate, load, and save against retention API mocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

vi.mock('@/features/admin/api/retentionApi.js', () => ({
  ADMIN_RETENTION_POLICY_QUERY_KEY: Object.freeze(['admin', 'retentionPolicy']),
  fetchRetentionPolicy: vi.fn(),
  updateRetentionPolicy: vi.fn(),
}));

import AdminRetention from '@/features/admin/AdminRetention';
import { fetchRetentionPolicy, updateRetentionPolicy } from '@/features/admin/api/retentionApi.js';

const DEFAULT_POLICY = {
  readySourceVersionsKeep: 3,
  jobDays: 180,
  notificationDays: 90,
  notificationReadDays: 30,
  usageDays: 730,
  conversationDays: 365,
  auditDays: 730,
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession('you@acme.io', { permissions: ['org.manage'] });
  fetchRetentionPolicy.mockReset();
  updateRetentionPolicy.mockReset();
  fetchRetentionPolicy.mockResolvedValue(DEFAULT_POLICY);
  updateRetentionPolicy.mockResolvedValue({ ...DEFAULT_POLICY, jobDays: 200 });
});

describe('AdminRetention', () => {
  it('shows a permission message and skips the API without org.manage', async () => {
    clearAuthSession();
    seedAuthSession('you@acme.io', { permissions: ['users.manage'] });
    renderWithProviders(<AdminRetention />);
    expect(await screen.findByText(/organization manage permission/i)).toBeTruthy();
    expect(fetchRetentionPolicy).not.toHaveBeenCalled();
  });

  it('loads policy fields and saves a patch', async () => {
    renderWithProviders(<AdminRetention />);
    expect(await screen.findByLabelText(/Processing job retention/i)).toBeTruthy();
    const jobInput = screen.getByLabelText(/Processing job retention/i);
    fireEvent.change(jobInput, { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: /Save retention settings/i }));
    await waitFor(() => {
      expect(updateRetentionPolicy).toHaveBeenCalled();
    });
    const payload = updateRetentionPolicy.mock.calls[0][0];
    expect(payload.jobDays).toBe(200);
    expect(payload.readySourceVersionsKeep).toBe(3);
    expect(typeof payload.idempotencyKey).toBe('string');
  });

  it('shows an alert when load fails', async () => {
    fetchRetentionPolicy.mockRejectedValue(new Error('down'));
    renderWithProviders(<AdminRetention />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
