import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import AdminUsers from './AdminUsers';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('AdminUsers', () => {
  it('lists users and opens the create dialog', () => {
    renderWithProviders(<AdminUsers />);

    expect(screen.getByRole('heading', { name: 'Users' })).toBeTruthy();
    expect(screen.getByText('Lena Park')).toBeTruthy();
    expect(screen.getByText('lena.park@acme.io')).toBeTruthy();
    expect(screen.getByText('Marcus Reyes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Invite user/i }));
    expect(screen.getByRole('heading', { name: 'Create user' })).toBeTruthy();
    expect(screen.getByLabelText(/Full name|Name/i)).toBeTruthy();
  });

  it('filters users by search query', () => {
    renderWithProviders(<AdminUsers />);

    fireEvent.change(screen.getByPlaceholderText('Search users'), {
      target: { value: 'Priya' },
    });
    expect(screen.getByText('Priya Nair')).toBeTruthy();
    expect(screen.queryByText('Lena Park')).toBeNull();
  });

  it('creates a user from the invite dialog', () => {
    renderWithProviders(<AdminUsers />);

    fireEvent.click(screen.getByRole('button', { name: /Invite user/i }));
    fireEvent.change(screen.getByLabelText('Full name'), {
      target: { value: 'New Hire' },
    });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'new.hire@acme.io' },
    });
    const inviteButtons = screen.getAllByRole('button', {
      name: /Invite user/i,
    });
    fireEvent.click(inviteButtons[inviteButtons.length - 1]!);
    expect(screen.getByText('New Hire')).toBeTruthy();
    expect(screen.getByText('new.hire@acme.io')).toBeTruthy();
  });

  it('keeps invite disabled until name and email are filled', () => {
    renderWithProviders(<AdminUsers />);

    fireEvent.click(screen.getByRole('button', { name: /Invite user/i }));
    const inviteButtons = screen.getAllByRole('button', {
      name: /Invite user/i,
    });
    expect(
      (inviteButtons[inviteButtons.length - 1] as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Create user' })).toBeNull();
  });
});
