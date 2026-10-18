import { MessageItem } from '@/features/chat/MessageItem';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession } from '@tests/renderWithProviders';

afterEach(() => {
  cleanup();
});
beforeEach(() => {
  clearAuthSession();
  localStorage.clear();
  seedAuthSession();
});
/**
 * Build a chat message for MessageItem tests.
 *
 * @param overrides - Partial message fields
 * @returns Chat message
 */
function buildMessage(overrides) {
  return {
    id: 'm_test',
    role: 'assistant',
    content: 'Default content',
    status: 'Completed',
    createdAt: '2026-09-11T12:00:00Z',
    ...overrides,
  };
}
describe('MessageItem', () => {
  it('renders a user message', () => {
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          role: 'user',
          content: 'How does authentication work?',
        })}
        isUser
        onEdit={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('How does authentication work?')).toBeTruthy();
  });
  it('renders an assistant message with markdown content', () => {
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: '## How authentication works\n\nJWT sessions.',
          status: 'Completed',
          knowledgeVersionId: '6650abcd9999',
          evidence: [
            {
              evidenceId: 'ev1',
              kind: 'code',
              path: 'src/auth/login.ts',
              startLine: 10,
              endLine: 40,
              excerpt: 'export function login() {}',
            },
          ],
        })}
        isUser={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onPreview={() => undefined}
        projectId="p1"
      />,
    );
    expect(screen.getByText('S')).toBeTruthy();
    expect(screen.getByText(/How authentication works/i)).toBeTruthy();
    expect(screen.getByText(/1 source/i)).toBeTruthy();
    expect(screen.getByText(/Knowledge 6650abcd/i)).toBeTruthy();
  });

  it('maps BE messageStatus without crashing on unknown values', () => {
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: 'Hello from API',
          messageStatus: 'completed',
          status: undefined,
        })}
        isUser={false}
      />,
    );
    expect(screen.getByText('Hello from API')).toBeTruthy();

    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: 'Odd status',
          messageStatus: 'future_status_code',
        })}
        isUser={false}
      />,
    );
    expect(screen.getByText('Odd status')).toBeTruthy();
  });

  it('shows generating chrome and failed state without retry when handler omitted', () => {
    const { unmount } = renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: '',
          messageStatus: 'generating',
        })}
        isUser={false}
      />,
    );
    expect(screen.getByText(/Generating answer/i)).toBeTruthy();
    unmount();

    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: '',
          messageStatus: 'failed',
        })}
        isUser={false}
      />,
    );
    expect(screen.getAllByText(/Generation failed/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
  });

  it('shows abstained copy without retry when handler omitted', () => {
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: '',
          messageStatus: 'abstained',
        })}
        isUser={false}
      />,
    );
    expect(screen.getAllByText(/Could not answer from project knowledge/i).length).toBeGreaterThan(0);
  });

  it('supports inline edit when canEdit is true', () => {
    const onEdit = vi.fn();
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          role: 'user',
          content: 'Original question',
        })}
        isUser
        canEdit
        onEdit={onEdit}
      />,
    );
    fireEvent.click(screen.getByLabelText('Edit'));
    fireEvent.change(screen.getByDisplayValue('Original question'), {
      target: { value: 'Edited question' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Submit edit/i }));
    expect(onEdit).toHaveBeenCalledWith('Edited question');
  });
  it('renders abstain notice with retry actions', () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: '',
          abstain: true,
          missing: ['payment provider docs'],
          status: 'Completed',
        })}
        isUser={false}
        onEdit={() => undefined}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/does not currently contain enough information/i)).toBeTruthy();
    expect(screen.getByText('payment provider docs')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try a narrower question/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Retry$/i })).toBeTruthy();
  });
  it('renders failed assistant messages with retry', () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: '',
          status: 'Failed',
        })}
        isUser={false}
        onEdit={() => undefined}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders interrupted assistant messages with retry', () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: 'Partial…',
          messageStatus: 'interrupted',
        })}
        isUser={false}
        onRetry={onRetry}
      />,
    );
    expect(screen.getAllByText(/Interrupted/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows stream stage chrome while streaming', () => {
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: '## Draft',
          messageStatus: 'generating',
        })}
        isUser={false}
        streaming
        streamStage="generating_answer"
      />,
    );
    expect(screen.getByText(/Generating answer/i)).toBeTruthy();
  });
  it('expands evidence sources and shows searching status', () => {
    const onPreview = vi.fn();
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: 'Working…',
          status: 'Searching',
        })}
        isUser={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(/Searching/i)).toBeTruthy();
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: 'Done',
          status: 'Completed',
          knowledgeVersionId: '6650abcd9999',
          evidence: [
            {
              evidenceId: 'ev1',
              kind: 'code',
              path: 'src/auth/login.ts',
              startLine: 10,
              endLine: 40,
              excerpt: 'export function login() {}',
            },
          ],
        })}
        isUser={false}
        onEdit={() => undefined}
        onRetry={() => undefined}
        onPreview={onPreview}
        projectId="p1"
        currentKnowledgeVersionId="current999"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /1 source/i }));
    expect(screen.getByText('src/auth/login.ts')).toBeTruthy();
    expect(screen.getByText('export function login() {}')).toBeTruthy();
    expect(screen.getByText(/Based on older knowledge 6650abcd/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Preview/i }));
    expect(onPreview).toHaveBeenCalledWith({ path: 'src/auth/login.ts', startLine: 10, endLine: 40 });
  });

  it('hides sources when evidence is empty and shows metrics when present', () => {
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: 'Done',
          messageStatus: 'completed',
          evidence: [],
          durationMs: 2500,
          usage: { inputTokens: 100, outputTokens: 50 },
        })}
        isUser={false}
        onPreview={() => undefined}
        projectId="p1"
      />,
    );
    expect(screen.queryByRole('button', { name: /source/i })).toBeNull();
    expect(screen.getByTestId('metrics-line')).toBeTruthy();
  });

  it('renders a completed general reply with note and no trust banner or sources', () => {
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: "_General answer, not based on this project's sources._\n\nParis.",
          messageStatus: 'completed',
          supportLevel: null,
          evidence: [],
        })}
        isUser={false}
        onPreview={() => undefined}
        projectId="p1"
      />,
    );
    expect(screen.getByText(/General answer, not based on this project's sources/i)).toBeTruthy();
    expect(screen.getByText(/Paris/i)).toBeTruthy();
    expect(screen.queryByText(/Not enough project evidence/i)).toBeNull();
    expect(screen.queryByText(/Could not answer from project knowledge/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /source/i })).toBeNull();
  });

  it('shows insufficient support banner for abstained turns', () => {
    renderWithProviders(
      <MessageItem
        message={buildMessage({
          content: 'Cannot say',
          messageStatus: 'abstained',
          supportLevel: 'insufficient',
        })}
        isUser={false}
      />,
    );
    expect(screen.getByText(/Not enough project evidence/i)).toBeTruthy();
  });
});
