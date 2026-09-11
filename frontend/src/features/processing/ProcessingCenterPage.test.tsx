import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import ProcessingCenterPage from './ProcessingCenterPage';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('ProcessingCenterPage', () => {
  it('shows in-progress jobs and history', () => {
    renderWithProviders(<ProcessingCenterPage />);

    expect(
      screen.getByRole('heading', { name: 'Processing Center' }),
    ).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText(/Knowledge update · Helios Gateway/)).toBeTruthy();
    expect(screen.getByText('68%')).toBeTruthy();
    expect(screen.getByText('History')).toBeTruthy();
    expect(screen.getAllByText(/Initial processing/).length).toBeGreaterThan(0);
  });

  it('retries a failed or partial history job', () => {
    renderWithProviders(<ProcessingCenterPage />);

    const retryButtons = screen.getAllByRole('button', { name: /Retry/i });
    expect(retryButtons.length).toBeGreaterThan(0);
    fireEvent.click(retryButtons[0]!);
    expect(screen.getByText('In progress')).toBeTruthy();
  });
});
