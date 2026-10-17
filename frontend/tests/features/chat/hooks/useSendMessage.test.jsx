/**
 * useSendMessage lifecycle: send, abort, 202, HTTP error.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { messageStreamReducer, useSendMessage } from '@/features/chat/hooks/useSendMessage.js';

const streamConversationMessage = vi.fn();
const retryConversationMessage = vi.fn();

vi.mock('@/features/chat/api/chatStreamApi.js', () => ({
  streamConversationMessage: (...args) => streamConversationMessage(...args),
  retryConversationMessage: (...args) => retryConversationMessage(...args),
  stageToI18nKey: (s) => `chat.stages.${s || 'working'}`,
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

  it('retries via retryConversationMessage', async () => {
    retryConversationMessage.mockResolvedValue({ kind: 'stream', terminal: 'done', messageId: 'm2' });
    const { result } = renderHook(() => useSendMessage({ projectId: 'p1', conversationId: 'c1' }), { wrapper });
    await act(async () => {
      await result.current.retry('asst_1');
    });
    expect(retryConversationMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'asst_1', idempotencyKey: expect.any(String) }));
    expect(result.current.stream.phase).toBe('completed');
  });
});
