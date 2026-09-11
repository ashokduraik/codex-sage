import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearAuthSession,
  renderWithProviders,
  seedAuthSession,
} from '@/test/renderWithProviders';

import { ConversationList } from './ConversationList';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});

describe('ConversationList', () => {
  it('lists conversations and notifies on select and new chat', () => {
    const onSelect = vi.fn();
    const onNew = vi.fn();
    renderWithProviders(
      <ConversationList
        projectId="prj_atlas"
        activeConvId="conv_1"
        onSelect={onSelect}
        onNew={onNew}
      />,
    );

    expect(screen.getByText('How does authentication work?')).toBeTruthy();
    expect(screen.getByText('Where is payment implemented?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
    expect(onNew).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Where is payment implemented?'));
    expect(onSelect).toHaveBeenCalledWith('conv_2');
  });

  it('filters conversations by search query', () => {
    renderWithProviders(
      <ConversationList
        projectId="prj_atlas"
        activeConvId={null}
        onSelect={() => undefined}
        onNew={() => undefined}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Search conversations'), {
      target: { value: 'payment' },
    });
    expect(screen.getByText('Where is payment implemented?')).toBeTruthy();
    expect(screen.queryByText('How does authentication work?')).toBeNull();
  });

  it('shows archived conversations and empty recent state after filtering', () => {
    renderWithProviders(
      <ConversationList
        projectId="prj_atlas"
        activeConvId={null}
        onSelect={() => undefined}
        onNew={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Archived/i }));
    expect(screen.getByText('Checkout flow walkthrough')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search conversations'), {
      target: { value: 'zzzz-no-match' },
    });
    expect(screen.getByText('No archived conversations.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
    expect(screen.getByText(/No conversations/i)).toBeTruthy();
  });
});
