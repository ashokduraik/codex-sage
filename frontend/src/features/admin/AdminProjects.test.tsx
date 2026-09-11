import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import AdminProjects from './AdminProjects';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('AdminProjects', () => {
  it('lists organization projects', () => {
    renderWithProviders(<AdminProjects />);

    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByText('Atlas Commerce')).toBeTruthy();
    expect(screen.getByText('Orion Analytics')).toBeTruthy();
    expect(screen.getByText('Helios Gateway')).toBeTruthy();
  });

  it('archives a project from the admin list', () => {
    renderWithProviders(<AdminProjects />);

    const archiveButtons = screen.getAllByRole('button', { name: /Archive/i });
    fireEvent.click(archiveButtons[0]!);
    expect(screen.getByRole('button', { name: /Restore/i })).toBeTruthy();
  });
});
