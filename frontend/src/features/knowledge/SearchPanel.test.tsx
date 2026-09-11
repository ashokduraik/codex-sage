import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';

import SearchPanel from './SearchPanel';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('SearchPanel', () => {
  it('filters knowledge results as the query changes', () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="search" element={<SearchPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/search' },
    );

    expect(screen.getByRole('heading', { name: 'Search' })).toBeTruthy();
    expect(screen.getByText('Search this project')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'Stripe' },
    });

    expect(screen.getByText('Stripe payment intent')).toBeTruthy();
    expect(screen.queryByText('Search this project')).toBeNull();
  });

  it('shows empty results for unmatched queries', () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="search" element={<SearchPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/search' },
    );

    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'zzzz-no-match' },
    });

    expect(screen.getByText('No results')).toBeTruthy();
  });

  it('filters results by knowledge type chip', () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />}>
          <Route path="search" element={<SearchPanel />} />
        </Route>
      </Routes>,
      { route: '/projects/prj_atlas/search' },
    );

    fireEvent.change(screen.getByPlaceholderText('Search knowledge…'), {
      target: { value: 'Stripe' },
    });
    expect(screen.getByText('Stripe payment intent')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'APIs' }));
    expect(screen.queryByText('Stripe payment intent')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(screen.getByText('Stripe payment intent')).toBeTruthy();
  });
});
