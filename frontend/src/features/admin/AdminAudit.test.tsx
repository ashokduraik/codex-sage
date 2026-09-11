import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import AdminAudit from './AdminAudit';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('AdminAudit', () => {
  it('lists audit entries and expands details', () => {
    renderWithProviders(<AdminAudit />);

    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeTruthy();
    expect(screen.getAllByText(/Connected repository/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText('acme/atlas-commerce')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search actor, action, target'), {
      target: { value: 'Orion' },
    });
    expect(screen.getByText('Orion Analytics')).toBeTruthy();
    expect(screen.queryByText('acme/atlas-commerce')).toBeNull();

    fireEvent.click(screen.getByText('Orion Analytics'));
    expect(screen.getByText(/Actor:/)).toBeTruthy();
    expect(screen.getByText(/Reference:/)).toBeTruthy();
  });
});
