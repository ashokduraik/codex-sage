/**
 * Global conversations page CTA (no cross-project list).
 */
import { cleanup, screen } from '@testing-library/react';
import ConversationsPage from '@/features/chat/ConversationsPage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
});
beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('ConversationsPage', () => {
  it('shows privacy copy and a CTA to projects', () => {
    renderWithProviders(<ConversationsPage />);
    expect(screen.getByRole('heading', { name: 'Conversations' })).toBeTruthy();
    expect(screen.getByText(/private to the signed-in user/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Open a project to view chat/i })).toBeTruthy();
    const link = screen.getByRole('link', { name: /Browse projects/i });
    expect(link.getAttribute('href')).toBe('/projects');
  });
});
