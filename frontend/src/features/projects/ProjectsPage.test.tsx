import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import ProjectsPage from './ProjectsPage';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('ProjectsPage', () => {
  it('lists projects and filters by search', () => {
    renderWithProviders(<ProjectsPage />);

    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByText('Atlas Commerce')).toBeTruthy();
    expect(screen.getByText('Orion Analytics')).toBeTruthy();
    expect(screen.getByText('Helios Gateway')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search projects…'), {
      target: { value: 'Atlas' },
    });
    expect(screen.getByText('Atlas Commerce')).toBeTruthy();
    expect(screen.queryByText('Orion Analytics')).toBeNull();
  });

  it('opens the create project dialog', () => {
    renderWithProviders(<ProjectsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Create project/i }));
    expect(screen.getByRole('heading', { name: 'Create project' })).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('toggles the archived projects filter', () => {
    renderWithProviders(<ProjectsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Active/i }));
    expect(screen.queryByText('Atlas Commerce')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Archived/i }));
    expect(screen.getByText('Atlas Commerce')).toBeTruthy();
  });
});
