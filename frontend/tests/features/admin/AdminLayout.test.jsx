import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';
import AdminLayout from '@/features/admin/AdminLayout';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
});

describe('AdminLayout', () => {
  it('renders admin nav and outlet child content', () => {
    seedAuthSession('you@acme.io', {
      permissions: ['audit.view', 'users.manage'],
    });
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
    expect(screen.getAllByText('Audit').length).toBeGreaterThan(0);
    expect(screen.queryByText('Usage')).toBeNull();
    expect(screen.getByText('Users outlet child')).toBeTruthy();
  });

  it('shows Usage when the caller has usage.view', () => {
    seedAuthSession('you@acme.io', {
      permissions: ['users.manage', 'usage.view'],
    });
    renderWithProviders(
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route path="users" element={<div>Users outlet child</div>} />
        </Route>
      </Routes>,
      { route: '/admin/users' },
    );
    expect(screen.getAllByText('Usage').length).toBeGreaterThan(0);
  });

  it('hides the Audit tab when the caller lacks audit.view', () => {
    seedAuthSession('you@acme.io', {
      permissions: ['users.manage'],
    });
    renderWithProviders(
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route path="users" element={<div>Users outlet child</div>} />
        </Route>
      </Routes>,
      { route: '/admin/users' },
    );
    expect(screen.getAllByText('Users').length).toBeGreaterThan(0);
    expect(screen.queryByText('Audit')).toBeNull();
  });
});
