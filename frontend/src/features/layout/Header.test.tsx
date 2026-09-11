import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import Header from './Header';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('Header', () => {
  it('renders org name and search placeholder', () => {
    renderWithProviders(<Header />);

    expect(screen.getByText('Acme Corp')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search projects…')).toBeTruthy();
  });

  it('invokes onMenu when the mobile menu button is clicked', () => {
    let opened = false;
    renderWithProviders(
      <Header
        onMenu={() => {
          opened = true;
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('Open menu'));
    expect(opened).toBe(true);
  });

  it('filters projects in the search dropdown', () => {
    renderWithProviders(<Header />);

    const input = screen.getByPlaceholderText('Search projects…');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Atlas' } });
    expect(screen.getByText('Atlas Commerce')).toBeTruthy();
  });
});
