/**
 * useSendMessage lifecycle: send, abort, 202, HTTP error.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { messageStreamReducer, useSendMessage } from '@/features/chat/hooks/useSendMessage.js';

const streamConversationMessage = vi.fn();
const retryConversationMessage = vi.fn();
const editConversationMessage = vi.fn();
const answerClarificationStream = vi.fn();

vi.mock('@/features/chat/api/chatStreamApi.js', () => ({
  streamConversationMessage: (...args) => streamConversationMessage(...args),
  retryConversationMessage: (...args) => retryConversationMessage(...args),
  editConversationMessage: (...args) => editConversationMessage(...args),
  stageToI18nKey: (s) => `chat.stages.${s || 'working'}`,
}));

vi.mock('@/features/chat/api/clarificationsApi.js', () => ({
  answerClarificationStream: (...args) => answerClarificationStream(...args),
  CLARIFICATION_FREE_TEXT_MAX_LENGTH: 2000,
}));

/**
 * @param {import('react').ReactNode} children Children.
 * @returns {import('react').ReactElement}
 */
function wrapper({ children }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  streamConversationMessage.mockReset();
  retryConversationMessage.mockReset();
  editConversationMessage.mockReset();
  answerClarificationStream.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('messageStreamReducer', () => {
  it('appends deltas and completes', () => {
    let state = messageStreamReducer(undefined, { type: 'reset' });
    state = messageStreamReducer(state, { type: 'posting', content: 'Q' });
    state = messageStreamReducer(state, { type: 'delta', text: 'A' });
    state = messageStreamReducer(state, { type: 'delta', text: 'B' });
    state = messageStreamReducer(state, { type: 'completed', messageId: 'm1' });
    expect(state.draftText).toBe('AB');
    expect(state.phase).toBe('completed');
    expect(state.assistantMessageId).toBe('m1');
  });

  it('records terminal error', () => {
    let state = messageStreamReducer(undefined, { type: 'reset' });
    state = messageStreamReducer(state, { type: 'failed', message: 'boom', reference: 'REQ-1' });
    expect(state.phase).toBe('failed');
    expect(state.errorMessage).toBe('boom');
  });
});

describe('useSendMessage', () => {
  it('streams to completed on done', async () => {
    streamConversationMessage.mockImplementation(async ({ onEvent }) => {
      onEvent?.({ event: 'status', data: { stage: 'generating_answer' } });
      onEvent?.({ event: 'delta', data: { text: 'Hi' } });
      return { kind: 'stream', terminal: 'done', messageId: 'm1' };
    });
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.send('Hello');
    });
    await waitFor(() => {
      expect(result.current.stream.phase).toBe('completed');
    });
    expect(result.current.stream.draftText).toBe('Hi');
  });

  it('marks cancelled on abort', async () => {
    streamConversationMessage.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    let sendPromise;
    act(() => {
      sendPromise = result.current.send('Hello');
    });
    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await sendPromise;
    });
    expect(result.current.stream.phase).toBe('cancelled');
  });

  it('handles 202 queued', async () => {
    streamConversationMessage.mockResolvedValue({
      kind: 'queued',
      body: { messageId: 'mq', messageStatus: 'queued' },
    });
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.send('Queued');
    });
    expect(result.current.stream.phase).toBe('queued');
    expect(result.current.stream.userMessageId).toBe('mq');
  });

  it('handles HTTP error before stream', async () => {
    const { ApiError } = await import('@/shared/api/ApiError.js');
    streamConversationMessage.mockRejectedValue(new ApiError({ status: 503, code: 'KNOWLEDGE_UNAVAILABLE', message: 'no knowledge' }));
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.send('Q');
    });
    expect(result.current.stream.phase).toBe('failed');
    expect(result.current.stream.errorMessage).toMatch(/no knowledge/i);
  });

  it('edits via editConversationMessage', async () => {
    editConversationMessage.mockImplementation(async ({ onEvent }) => {
      onEvent?.({ event: 'delta', data: { text: 'Edited' } });
      return { kind: 'stream', terminal: 'done', messageId: 'm_edit' };
    });
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.edit('user_1', 'Revised question');
    });
    await waitFor(() => {
      expect(result.current.stream.phase).toBe('completed');
    });
    expect(editConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'user_1',
        content: 'Revised question',
        idempotencyKey: expect.any(String),
      }),
    );
    expect(result.current.stream.draftText).toBe('Edited');
  });

  it('retries via retryConversationMessage', async () => {
    retryConversationMessage.mockResolvedValue({ kind: 'stream', terminal: 'done', messageId: 'm2' });
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.retry('asst_1');
    });
    expect(retryConversationMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'asst_1', idempotencyKey: expect.any(String) }));
    expect(result.current.stream.phase).toBe('completed');
  });

  it('enters awaiting_clarification without marking interrupted', async () => {
    streamConversationMessage.mockImplementation(async ({ onEvent }) => {
      onEvent?.({
        event: 'clarification',
        data: {
          messageId: 'msg_a',
          clarificationSetId: 'clr_1',
          roundIndex: 0,
          questions: [{ id: 'q1', type: 'single_select', prompt: 'Env?', options: ['A'], required: true }],
        },
      });
      return { kind: 'stream', terminal: 'awaiting_clarification', messageId: 'msg_a' };
    });
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.send('Need clarify');
    });
    expect(result.current.stream.phase).toBe('awaiting_clarification');
    expect(result.current.stream.needsClarification).toBe(true);
    expect(result.current.stream.assistantMessageId).toBe('msg_a');
    expect(result.current.stream.clarification?.clarificationSetId).toBe('clr_1');
  });

  it('submits clarification answers once and completes', async () => {
    answerClarificationStream.mockImplementation(async ({ onEvent }) => {
      onEvent?.({ event: 'delta', data: { text: 'Answer' } });
      return { kind: 'stream', terminal: 'done', messageId: 'msg_a' };
    });
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.submitClarificationAnswers({
        conversationId: 'c1',
        messageId: 'msg_a',
        clarificationSetId: 'clr_1',
        answers: { q1: 'Production' },
      });
    });
    expect(answerClarificationStream).toHaveBeenCalledTimes(1);
    expect(answerClarificationStream).toHaveBeenCalledWith(
      expect.objectContaining({
        clarificationSetId: 'clr_1',
        answers: { q1: 'Production' },
        idempotencyKey: expect.any(String),
      }),
    );
    expect(result.current.stream.phase).toBe('completed');
    expect(result.current.stream.needsClarification).toBe(false);
  });

  it('preserves clarification phase after answer POST HTTP failure', async () => {
    const { ApiError } = await import('@/shared/api/ApiError.js');
    answerClarificationStream.mockRejectedValue(new ApiError({ status: 409, code: 'CLARIFICATION_NOT_OPEN', message: 'not open' }));
    let state = messageStreamReducer(undefined, {
      type: 'clarification',
      payload: { messageId: 'msg_a', clarificationSetId: 'clr_1', questions: [{ id: 'q1' }] },
    });
    expect(state.phase).toBe('awaiting_clarification');

    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.submitClarificationAnswers({
        conversationId: 'c1',
        messageId: 'msg_a',
        clarificationSetId: 'clr_1',
        answers: { q1: 'Production' },
      });
    });
    expect(result.current.stream.phase).toBe('awaiting_clarification');
    expect(result.current.stream.errorMessage).toMatch(/not open/i);
  });

  it('replaces clarification on a second-round event during answer resume', async () => {
    answerClarificationStream.mockImplementation(async ({ onEvent }) => {
      onEvent?.({
        event: 'clarification',
        data: {
          messageId: 'msg_a',
          clarificationSetId: 'clr_r1',
          roundIndex: 1,
          questions: [{ id: 'q9', type: 'free_text', prompt: 'More?', required: true }],
        },
      });
      return { kind: 'stream', terminal: 'awaiting_clarification', messageId: 'msg_a' };
    });
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.submitClarificationAnswers({
        conversationId: 'c1',
        messageId: 'msg_a',
        clarificationSetId: 'clr_r0',
        answers: { q1: 'Production' },
      });
    });
    expect(result.current.stream.phase).toBe('awaiting_clarification');
    expect(result.current.stream.clarification?.clarificationSetId).toBe('clr_r1');
  });

  it('clearClarification drops the stash', () => {
    let state = messageStreamReducer(undefined, {
      type: 'clarification',
      payload: { clarificationSetId: 'clr_1', questions: [] },
    });
    state = messageStreamReducer(state, { type: 'clear_clarification' });
    expect(state.clarification).toBeNull();
    expect(state.needsClarification).toBe(false);
  });

  it('clearStream resets to idle via the hook', () => {
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    act(() => {
      result.current.clearStream();
    });
    expect(result.current.stream.phase).toBe('idle');
  });

  it('marks interrupted when the stream terminal is interrupted', async () => {
    streamConversationMessage.mockResolvedValue({ kind: 'stream', terminal: 'interrupted' });
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.send('Q');
    });
    expect(result.current.stream.phase).toBe('interrupted');
  });

  it('clears clarification stash on first delta after resume', () => {
    let state = messageStreamReducer(undefined, {
      type: 'clarification',
      payload: { clarificationSetId: 'clr_1', messageId: 'm1', questions: [{ id: 'q1' }] },
    });
    state = messageStreamReducer(state, { type: 'delta', text: 'Hello' });
    expect(state.clarification).toBeNull();
    expect(state.needsClarification).toBe(false);
    expect(state.draftText).toBe('Hello');
  });
});
