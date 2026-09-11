import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import AdminLayout from './AdminLayout';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('AdminLayout', () => {
  it('renders admin nav and outlet child content', () => {
    renderWithProviders(
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route path="users" element={<div>Users outlet child</div>} />
        </Route>
      </Routes>,
      { route: '/admin/users' },
    );

    expect(screen.getByText('Administration')).toBeTruthy();
    expect(screen.getAllByText('Users').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Roles & Permissions').length).toBeGreaterThan(0);
    expect(screen.getByText('Users outlet child')).toBeTruthy();
  });
});
