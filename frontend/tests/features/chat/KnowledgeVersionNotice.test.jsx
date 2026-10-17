/**
 * KnowledgeVersionNotice session banner tests.
 */
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import KnowledgeVersionNotice, { knowledgeVersionNoticeStorageKey } from '@/features/chat/KnowledgeVersionNotice.jsx';
import { renderWithProviders } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

beforeEach(() => {
  sessionStorage.clear();
});

describe('KnowledgeVersionNotice', () => {
  it('shows when messages cite a different knowledge version', () => {
    renderWithProviders(<KnowledgeVersionNotice projectId="p1" currentKnowledgeVersionId="current" messages={[{ knowledgeVersionId: 'old' }]} />);
    expect(screen.getByTestId('knowledge-version-notice')).toBeTruthy();
  });

  it('does not show when all messages match current or after dismiss', () => {
    const { rerender } = renderWithProviders(
      <KnowledgeVersionNotice projectId="p1" currentKnowledgeVersionId="current" messages={[{ knowledgeVersionId: 'current' }]} />,
    );
    expect(screen.queryByTestId('knowledge-version-notice')).toBeNull();

    rerender(<KnowledgeVersionNotice projectId="p1" currentKnowledgeVersionId="current" messages={[{ knowledgeVersionId: 'old' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
    expect(sessionStorage.getItem(knowledgeVersionNoticeStorageKey('p1'))).toBe('1');
    expect(screen.queryByTestId('knowledge-version-notice')).toBeNull();
  });
});
