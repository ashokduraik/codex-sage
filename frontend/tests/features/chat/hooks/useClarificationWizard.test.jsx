/**
 * useClarificationWizard — sequential answers, validation, sessionStorage.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearClarificationSession,
  clarificationSessionKey,
  useClarificationWizard,
  validateClarificationAnswer,
} from '@/features/chat/hooks/useClarificationWizard.js';

const SAMPLE_SET = {
  clarificationSetId: 'clr_r0_a',
  roundIndex: 0,
  messageId: 'msg_1',
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
      type: 'multi_select',
      prompt: 'Which areas?',
      options: ['orders', 'payments'],
      required: true,
    },
    {
      id: 'q3',
      type: 'free_text',
      prompt: 'Anything else?',
      required: true,
    },
  ],
};

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('validateClarificationAnswer', () => {
  it('requires single_select choice and multi_select at least one', () => {
    expect(validateClarificationAnswer(SAMPLE_SET.questions[0], undefined)).toBe('chat.clarification.validationRequired');
    expect(validateClarificationAnswer(SAMPLE_SET.questions[0], 'Production')).toBeNull();
    expect(validateClarificationAnswer(SAMPLE_SET.questions[1], [])).toBe('chat.clarification.validationMultiRequired');
    expect(validateClarificationAnswer(SAMPLE_SET.questions[1], ['orders'])).toBeNull();
  });

  it('rejects free_text over max length', () => {
    const long = 'x'.repeat(2001);
    expect(validateClarificationAnswer(SAMPLE_SET.questions[2], long)).toBe('chat.clarification.validationTooLong');
  });
});

describe('useClarificationWizard', () => {
  it('shows one question at a time and advances after a valid answer', () => {
    const { result } = renderHook(() => useClarificationWizard({ conversationId: 'c1', setPayload: SAMPLE_SET }));
    expect(result.current.active).toBe(true);
    expect(result.current.currentQuestion?.id).toBe('q1');
    expect(result.current.isLast).toBe(false);

    act(() => {
      result.current.setAnswer('Production');
    });
    act(() => {
      expect(result.current.goNext()).toBe(true);
    });
    expect(result.current.currentQuestion?.id).toBe('q2');
  });

  it('supports back navigation without clearing answers', () => {
    const { result } = renderHook(() => useClarificationWizard({ conversationId: 'c1', setPayload: SAMPLE_SET }));
    act(() => {
      result.current.setAnswer('Staging');
      result.current.goNext();
    });
    act(() => {
      result.current.goBack();
    });
    expect(result.current.currentQuestion?.id).toBe('q1');
    expect(result.current.currentAnswer).toBe('Staging');
  });

  it('restores progress from sessionStorage', () => {
    sessionStorage.setItem(clarificationSessionKey('c1', 'clr_r0_a'), JSON.stringify({ currentIndex: 1, answersByQuestionId: { q1: 'Production' } }));
    const { result } = renderHook(() => useClarificationWizard({ conversationId: 'c1', setPayload: SAMPLE_SET }));
    expect(result.current.currentIndex).toBe(1);
    expect(result.current.answersByQuestionId.q1).toBe('Production');
  });

  it('fails closed on empty questions', () => {
    const { result } = renderHook(() =>
      useClarificationWizard({
        conversationId: 'c1',
        setPayload: { clarificationSetId: 'clr_empty', questions: [] },
      }),
    );
    expect(result.current.emptySetError).toBe(true);
    expect(result.current.active).toBe(false);
  });

  it('replaces state and sets follow-up notice when set id changes', () => {
    const { result, rerender } = renderHook(({ setPayload }) => useClarificationWizard({ conversationId: 'c1', setPayload }), {
      initialProps: { setPayload: SAMPLE_SET },
    });
    act(() => {
      result.current.setAnswer('Production');
    });
    const nextSet = {
      ...SAMPLE_SET,
      clarificationSetId: 'clr_r1_b',
      roundIndex: 1,
      questions: [
        {
          id: 'q9',
          type: 'free_text',
          prompt: 'More detail?',
          required: true,
        },
      ],
    };
    rerender({ setPayload: nextSet });
    expect(result.current.followUpNotice).toBe(true);
    expect(result.current.currentQuestion?.id).toBe('q9');
    expect(result.current.answersByQuestionId.q1).toBeUndefined();
  });

  it('buildAnswersForSubmit returns the full map after all answers', () => {
    const { result } = renderHook(() => useClarificationWizard({ conversationId: 'c1', setPayload: SAMPLE_SET }));
    act(() => {
      result.current.setAnswer('Production');
    });
    act(() => {
      expect(result.current.goNext()).toBe(true);
    });
    act(() => {
      result.current.setAnswer(['orders', 'payments']);
    });
    act(() => {
      expect(result.current.goNext()).toBe(true);
    });
    act(() => {
      result.current.setAnswer('  Enterprise  ');
    });
    let answers;
    act(() => {
      answers = result.current.buildAnswersForSubmit();
    });
    expect(answers).toEqual({
      q1: 'Production',
      q2: ['orders', 'payments'],
      q3: 'Enterprise',
    });
    clearClarificationSession('c1', 'clr_r0_a');
  });
});
