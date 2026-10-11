import { cleanup, screen } from '@testing-library/react';
import AdminRetention from '@/features/admin/AdminRetention';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('AdminRetention', () => {
  it('renders read-only default windows without switches', () => {
    renderWithProviders(<AdminRetention />);
    expect(screen.getByRole('heading', { name: 'Retention' })).toBeTruthy();
    expect(screen.getByText('Last 3 ready source versions')).toBeTruthy();
    expect(screen.getByText('Processing jobs')).toBeTruthy();
    expect(screen.getByText('Notifications')).toBeTruthy();
    expect(screen.getByText('Usage records')).toBeTruthy();
    expect(screen.getByText('Conversation retention')).toBeTruthy();
    expect(screen.getByText('Audit log retention')).toBeTruthy();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });
});
