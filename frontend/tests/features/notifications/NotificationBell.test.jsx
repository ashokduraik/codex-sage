/**
 * Header notification bell behavior.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

vi.mock('@/features/notifications/hooks/useNotifications.js', () => ({
  useNotifications: vi.fn(),
  useNotificationActions: vi.fn(),
}));

import NotificationBell, { pathForNotification } from '@/features/notifications/NotificationBell';
import { useNotificationActions, useNotifications } from '@/features/notifications/hooks/useNotifications.js';

describe('pathForNotification', () => {
  it('routes to processing when a job id is present', () => {
    expect(pathForNotification({ projectId: 'p1', jobId: 'j1' })).toBe('/processing?projectId=p1');
  });

  it('routes to sources when only a project id is present', () => {
    expect(pathForNotification({ projectId: 'p1' })).toBe('/projects/p1/sources');
  });

  it('falls back to processing without a project', () => {
    expect(pathForNotification({})).toBe('/processing');
  });
});

describe('NotificationBell', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
    useNotificationActions.mockReturnValue({
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      isMarking: false,
    });
  });

  it('hides the unread badge when unreadTotal is 0', () => {
    useNotifications.mockReturnValue({
      data: { items: [], nextCursor: null, unreadTotal: 0 },
      isLoading: false,
      error: null,
    });
    renderWithProviders(<NotificationBell />);
    expect(screen.getByLabelText('Notifications')).toBeTruthy();
    expect(document.querySelector('.bg-brand')).toBeNull();
  });

  it('shows the unread badge from API unreadTotal only', () => {
    useNotifications.mockReturnValue({
      data: {
        items: [
          {
            id: 'n1',
            title: 'Knowledge update completed',
            body: 'Done',
            resourceRef: { projectId: 'p1', jobId: 'j1' },
            readAt: null,
          },
        ],
        nextCursor: null,
        unreadTotal: 4,
      },
      isLoading: false,
      error: null,
    });
    renderWithProviders(<NotificationBell />);
    expect(document.querySelector('.bg-brand')).toBeTruthy();
  });

  it('does not invent a badge while loading', () => {
    useNotifications.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    renderWithProviders(<NotificationBell />);
    expect(document.querySelector('.bg-brand')).toBeNull();
  });

  it('renders without inventing unread when the query errored', () => {
    useNotifications.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('boom'),
    });
    renderWithProviders(<NotificationBell />);
    expect(screen.getByLabelText('Notifications')).toBeTruthy();
    expect(document.querySelector('.bg-brand')).toBeNull();
  });
});
