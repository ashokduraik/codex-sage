import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import AdminRoles from './AdminRoles';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('AdminRoles', () => {
  it('renders the roles and permissions matrix', () => {
    renderWithProviders(<AdminRoles />);

    expect(
      screen.getByRole('heading', { name: 'Roles & Permissions' }),
    ).toBeTruthy();
    expect(screen.getByText('Permission')).toBeTruthy();
    expect(screen.getByText('Admin')).toBeTruthy();
    expect(screen.getByText('Editor')).toBeTruthy();
    expect(screen.getByText('Viewer')).toBeTruthy();
    expect(screen.getByText('Manage users')).toBeTruthy();
    expect(screen.getByText('Ask questions')).toBeTruthy();
  });
});
