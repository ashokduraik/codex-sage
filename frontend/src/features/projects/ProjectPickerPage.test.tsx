import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import ProjectPickerPage from './ProjectPickerPage';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('ProjectPickerPage', () => {
  it('lists projects for chat destination', () => {
    renderWithProviders(<ProjectPickerPage tab="chat" />);

    expect(screen.getByRole('heading', { name: 'Chat' })).toBeTruthy();
    expect(screen.getByText('Atlas Commerce')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /Atlas Commerce/i }).getAttribute('href'),
    ).toBe('/projects/prj_atlas/chat');
  });

  it('lists projects for knowledge destination', () => {
    renderWithProviders(<ProjectPickerPage tab="knowledge" />);

    expect(screen.getByRole('heading', { name: 'Knowledge' })).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /Orion Analytics/i })
        .getAttribute('href'),
    ).toBe('/projects/prj_orion/knowledge');
  });

  it('lists projects for search destination', () => {
    renderWithProviders(<ProjectPickerPage tab="search" />);

    expect(screen.getByRole('heading', { name: 'Search' })).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /Helios Gateway/i })
        .getAttribute('href'),
    ).toBe('/projects/prj_helios/search');
  });
});
