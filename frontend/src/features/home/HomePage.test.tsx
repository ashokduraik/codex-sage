import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';
import { SUGGESTED_QUESTIONS } from '@/shared/mock-data';

import HomePage from './HomePage';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('HomePage', () => {
  it('renders hero, suggested questions, and recent projects', () => {
    renderWithProviders(<HomePage />);

    expect(
      screen.getByRole('heading', { name: 'Understand your software system.' }),
    ).toBeTruthy();
    expect(screen.getByText('Suggested starting questions')).toBeTruthy();
    expect(screen.getByText('Recent projects')).toBeTruthy();
    expect(screen.getAllByText('Atlas Commerce').length).toBeGreaterThan(0);
    expect(screen.getByText(SUGGESTED_QUESTIONS[0]!)).toBeTruthy();
    expect(
      screen.getAllByText('How does authentication work?').length,
    ).toBeGreaterThan(0);
  });

  it('navigates from hero CTAs and suggested questions', () => {
    renderWithProviders(<HomePage />);

    fireEvent.click(screen.getByRole('button', { name: /Ask anything/i }));
    fireEvent.click(screen.getByRole('button', { name: /New project/i }));
    fireEvent.click(screen.getByText(SUGGESTED_QUESTIONS[0]!));
  });
});
