/**
 * ClarificationPanel sequential UX and single submit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ClarificationPanel } from '@/features/chat/ClarificationPanel.jsx';
import { useClarificationWizard } from '@/features/chat/hooks/useClarificationWizard.js';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const SET = {
  clarificationSetId: 'clr_1',
  roundIndex: 0,
  messageId: 'm1',
  questions: [
    {
      id: 'q1',
      type: 'single_select',
      prompt: 'Which environment?',
      options: ['Production', 'Staging'],
      required: true,
    },
    {
      id: 'q2',
      type: 'free_text',
      prompt: 'Segment?',
      required: true,
    },
  ],
};

/**
 * Harness that owns the wizard hook for the panel.
 * @param {{ onSubmit: Function }} props Submit spy.
 * @returns {import('react').ReactElement}
 */
function PanelHarness({ onSubmit }) {
  const wizard = useClarificationWizard({ conversationId: 'c1', setPayload: SET });
  return <ClarificationPanel wizard={wizard} onSubmit={onSubmit} />;
}

describe('ClarificationPanel', () => {
  it('shows only the first question and blocks Next without a choice', () => {
    render(<PanelHarness onSubmit={vi.fn()} />);
    expect(screen.getByText('Which environment?')).toBeTruthy();
    expect(screen.queryByText('Segment?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Which environment?')).toBeTruthy();
  });

  it('submits once with the full answers map on the last question', () => {
    const onSubmit = vi.fn();
    render(<PanelHarness onSubmit={onSubmit} />);
    fireEvent.click(screen.getByDisplayValue('Production'));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.change(screen.getByPlaceholderText(/enter your answer/i), { target: { value: 'Enterprise' } });
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ q1: 'Production', q2: 'Enterprise' });
  });

  it('shows empty-set error without a blank panel', () => {
    /**
     * @returns {import('react').ReactElement}
     */
    function EmptyHarness() {
      const wizard = useClarificationWizard({
        conversationId: 'c1',
        setPayload: { clarificationSetId: 'clr_x', questions: [] },
      });
      return <ClarificationPanel wizard={wizard} onSubmit={vi.fn()} />;
    }
    render(<EmptyHarness />);
    expect(screen.getByRole('alert').textContent).toMatch(/missing/i);
  });

  it('shows Back after advancing and follow-up notice when flagged', () => {
    /**
     * @returns {import('react').ReactElement}
     */
    function NoticeHarness() {
      const wizard = useClarificationWizard({
        conversationId: 'c1',
        setPayload: SET,
        followUpNotice: true,
      });
      return <ClarificationPanel wizard={wizard} onSubmit={vi.fn()} submitting={false} submitError="server said no" />;
    }
    render(<NoticeHarness />);
    expect(screen.getByText(/More detail is needed/i)).toBeTruthy();
    fireEvent.click(screen.getByDisplayValue('Production'));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByRole('button', { name: /back/i })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/server said no/i);
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByText('Which environment?')).toBeTruthy();
  });

  it('does not submit while submitting is true', () => {
    const onSubmit = vi.fn();
    /**
     * @returns {import('react').ReactElement}
     */
    function BusyHarness() {
      const wizard = useClarificationWizard({
        conversationId: 'c1',
        setPayload: {
          clarificationSetId: 'clr_busy',
          questions: [
            {
              id: 'q1',
              type: 'single_select',
              prompt: 'Only?',
              options: ['Yes'],
              required: true,
            },
          ],
        },
      });
      return <ClarificationPanel wizard={wizard} onSubmit={onSubmit} submitting />;
    }
    render(<BusyHarness />);
    fireEvent.click(screen.getByDisplayValue('Yes'));
    fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('returns null when the wizard is inactive', () => {
    const inactiveWizard = {
      active: false,
      emptySetError: false,
      followUpNotice: false,
      currentIndex: 0,
      questionCount: 0,
      currentQuestion: null,
      currentAnswer: undefined,
      validationErrorKey: null,
      isLast: true,
      canGoBack: false,
      setAnswer: vi.fn(),
      goNext: vi.fn(),
      goBack: vi.fn(),
      buildAnswersForSubmit: vi.fn(),
    };
    const { container } = render(<ClarificationPanel wizard={inactiveWizard} onSubmit={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
