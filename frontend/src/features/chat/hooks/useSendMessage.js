/**
 * Sends / retries chat messages over SSE and holds the in-flight draft (stage, deltas, terminals).
 */
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isRequestAbortedError } from '@/shared/api/ApiError.js';
import { messageFromUnknown } from '@/shared/api';
import {
  CONVERSATIONS_DETAIL_QUERY_ROOT,
  CONVERSATIONS_LIST_QUERY_ROOT,
  CONVERSATIONS_MESSAGES_QUERY_ROOT,
} from '@/features/chat/conversationQueryKeys.js';
import { retryConversationMessage, streamConversationMessage } from '@/features/chat/api/chatStreamApi.js';

/**
 * @typedef {'idle' | 'posting' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'queued'} StreamPhase
 */

/**
 * @typedef {object} MessageStreamState
 * @property {StreamPhase} phase Lifecycle phase.
 * @property {string} stage Latest status stage (or empty).
 * @property {string} draftText Accumulated assistant markdown.
 * @property {unknown[]} evidenceItems Evidence stash for Phase 57.
 * @property {unknown | null} clarification Clarification payload stash for Phase 56.
 * @property {string | null} assistantMessageId Server assistant id when known.
 * @property {string | null} userMessageId Optimistic / queued user id.
 * @property {string | null} errorMessage User-facing error copy.
 * @property {string | null} errorReference Correlation id when present.
 * @property {string | null} optimisticUserContent Pending user bubble text.
 * @property {boolean} needsClarification Stub flag when clarification event arrived.
 */

/** Initial idle stream state. */
const INITIAL_STREAM_STATE = Object.freeze({
  phase: /** @type {StreamPhase} */ ('idle'),
  stage: '',
  draftText: '',
  evidenceItems: /** @type {unknown[]} */ ([]),
  clarification: null,
  assistantMessageId: null,
  userMessageId: null,
  errorMessage: null,
  errorReference: null,
  optimisticUserContent: null,
  needsClarification: false,
});

/**
 * Reduces SSE / lifecycle actions into stream UI state.
 * @param {MessageStreamState} state Current state.
 * @param {{ type: string, [key: string]: unknown }} action Reducer action.
 * @returns {MessageStreamState}
 */
export function messageStreamReducer(state = { ...INITIAL_STREAM_STATE }, action) {
  switch (action.type) {
    case 'reset':
      return { ...INITIAL_STREAM_STATE };
    case 'posting':
      return {
        ...INITIAL_STREAM_STATE,
        phase: 'posting',
        optimisticUserContent: typeof action.content === 'string' ? action.content : null,
      };
    case 'streaming':
      return { ...state, phase: 'streaming' };
    case 'status':
      return {
        ...state,
        phase: state.phase === 'posting' ? 'streaming' : state.phase,
        stage: typeof action.stage === 'string' ? action.stage : state.stage,
      };
    case 'delta':
      return {
        ...state,
        phase: 'streaming',
        draftText: `${state.draftText}${typeof action.text === 'string' ? action.text : ''}`,
      };
    case 'evidence':
      return {
        ...state,
        evidenceItems: Array.isArray(action.items) ? [...state.evidenceItems, ...action.items] : state.evidenceItems,
      };
    case 'clarification':
      return {
        ...state,
        clarification: action.payload ?? null,
        needsClarification: true,
        stage: 'awaiting_clarification',
      };
    case 'completed':
      return {
        ...state,
        phase: 'completed',
        assistantMessageId: typeof action.messageId === 'string' ? action.messageId : state.assistantMessageId,
        stage: '',
      };
    case 'failed':
      return {
        ...state,
        phase: 'failed',
        errorMessage: typeof action.message === 'string' ? action.message : state.errorMessage,
        errorReference: typeof action.reference === 'string' ? action.reference : state.errorReference,
      };
    case 'cancelled':
      return { ...state, phase: 'cancelled', stage: '' };
    case 'interrupted':
      return { ...state, phase: 'interrupted', stage: '' };
    case 'queued':
      return {
        ...state,
        phase: 'queued',
        userMessageId: typeof action.messageId === 'string' ? action.messageId : state.userMessageId,
        stage: '',
      };
    default:
      return state;
  }
}

/**
 * Hook: send / stop / retry grounded chat over SSE for one conversation.
 * @param {{ projectId: string, conversationId: string | null }} input Scope.
 * @returns {{
 *   stream: MessageStreamState,
 *   isBusy: boolean,
 *   send: (content: string, options?: { conversationId?: string }) => Promise<void>,
 *   retry: (assistantMessageId: string) => Promise<void>,
 *   stop: () => void,
 *   clearStream: () => void,
 * }}
 */
export function useSendMessage(input) {
  const queryClient = useQueryClient();
  const [stream, setStream] = useState(() => ({ ...INITIAL_STREAM_STATE }));
  const abortRef = useRef(/** @type {AbortController | null} */ (null));
  const busyRef = useRef(false);

  /**
   * Applies a reducer action.
   * @param {{ type: string, [key: string]: unknown }} action Action.
   */
  function dispatch(action) {
    setStream((prev) => messageStreamReducer(prev, action));
  }

  /**
   * Invalidates conversation list/detail/messages after a terminal outcome.
   * @returns {Promise<void>}
   */
  async function invalidateConversationQueries() {
    const projectId = String(input.projectId || '');
    if (!projectId) {
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CONVERSATIONS_MESSAGES_QUERY_ROOT }),
      queryClient.invalidateQueries({ queryKey: CONVERSATIONS_DETAIL_QUERY_ROOT }),
      queryClient.invalidateQueries({ queryKey: CONVERSATIONS_LIST_QUERY_ROOT }),
    ]);
  }

  /**
   * Shared SSE event → reducer mapping.
   * @param {{ event: string, data: unknown }} frame Frame.
   */
  function onEvent(frame) {
    const data = frame.data && typeof frame.data === 'object' ? /** @type {Record<string, unknown>} */ (frame.data) : {};
    if (frame.event === 'status') {
      dispatch({ type: 'status', stage: typeof data.stage === 'string' ? data.stage : '' });
    } else if (frame.event === 'delta') {
      dispatch({ type: 'delta', text: typeof data.text === 'string' ? data.text : '' });
    } else if (frame.event === 'evidence') {
      dispatch({ type: 'evidence', items: Array.isArray(data.items) ? data.items : [] });
    } else if (frame.event === 'clarification') {
      dispatch({ type: 'clarification', payload: data });
    }
  }

  /**
   * Runs a stream result into terminal reducer actions and invalidates caches.
   * @param {Awaited<ReturnType<typeof streamConversationMessage>>} result API result.
   * @returns {Promise<void>}
   */
  async function finishResult(result) {
    if (result.kind === 'queued') {
      const body = result.body && typeof result.body === 'object' ? /** @type {Record<string, unknown>} */ (result.body) : {};
      dispatch({
        type: 'queued',
        messageId: typeof body.messageId === 'string' ? body.messageId : null,
      });
      await invalidateConversationQueries();
      return;
    }
    if (result.terminal === 'done') {
      dispatch({ type: 'completed', messageId: result.messageId });
      await invalidateConversationQueries();
      return;
    }
    if (result.terminal === 'cancelled') {
      dispatch({ type: 'cancelled' });
      await invalidateConversationQueries();
      return;
    }
    if (result.terminal === 'interrupted') {
      dispatch({ type: 'interrupted' });
      await invalidateConversationQueries();
      return;
    }
    const err = result.error && typeof result.error === 'object' ? /** @type {Record<string, unknown>} */ (result.error) : {};
    dispatch({
      type: 'failed',
      message: typeof err.message === 'string' ? err.message : messageFromUnknown(err, 'Generation failed.'),
      reference: typeof err.reference === 'string' ? err.reference : null,
    });
    await invalidateConversationQueries();
  }

  /**
   * Sends a new user question on the active conversation.
   * @param {string} content Question text.
   * @param {{ conversationId?: string }} [options] Optional conversation override (after create).
   * @returns {Promise<void>}
   */
  async function send(content, options = {}) {
    const projectId = String(input.projectId || '');
    const conversationId = String(options.conversationId || input.conversationId || '');
    const trimmed = typeof content === 'string' ? content.trim() : '';
    if (!projectId || !conversationId || !trimmed || busyRef.current) {
      return;
    }
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: 'posting', content: trimmed });
    try {
      const result = await streamConversationMessage({
        projectId,
        conversationId,
        content: trimmed,
        idempotencyKey: crypto.randomUUID(),
        signal: controller.signal,
        onEvent: (frame) => {
          if (frame.event === 'status' || frame.event === 'delta') {
            dispatch({ type: 'streaming' });
          }
          onEvent(frame);
        },
      });
      await finishResult(result);
    } catch (error) {
      if (isRequestAbortedError(error) || controller.signal.aborted) {
        dispatch({ type: 'cancelled' });
        await invalidateConversationQueries();
      } else {
        const apiErr = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
        dispatch({
          type: 'failed',
          message: messageFromUnknown(error),
          reference: typeof apiErr.correlationId === 'string' ? apiErr.correlationId : null,
        });
      }
    } finally {
      busyRef.current = false;
      abortRef.current = null;
    }
  }

  /**
   * Retries the latest failed/interrupted assistant message.
   * @param {string} assistantMessageId Assistant message id.
   * @returns {Promise<void>}
   */
  async function retry(assistantMessageId) {
    const projectId = String(input.projectId || '');
    const conversationId = input.conversationId ? String(input.conversationId) : '';
    const messageId = String(assistantMessageId || '');
    if (!projectId || !conversationId || !messageId || busyRef.current) {
      return;
    }
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: 'posting', content: null });
    try {
      const result = await retryConversationMessage({
        projectId,
        conversationId,
        messageId,
        idempotencyKey: crypto.randomUUID(),
        signal: controller.signal,
        onEvent,
      });
      await finishResult(result);
    } catch (error) {
      if (isRequestAbortedError(error) || controller.signal.aborted) {
        dispatch({ type: 'cancelled' });
        await invalidateConversationQueries();
      } else {
        const apiErr = error && typeof error === 'object' ? /** @type {Record<string, unknown>} */ (error) : {};
        dispatch({
          type: 'failed',
          message: messageFromUnknown(error),
          reference: typeof apiErr.correlationId === 'string' ? apiErr.correlationId : null,
        });
      }
    } finally {
      busyRef.current = false;
      abortRef.current = null;
    }
  }

  /**
   * Aborts the in-flight fetch (Stop) so the backend marks interrupted.
   */
  function stop() {
    abortRef.current?.abort();
  }

  /**
   * Clears local stream chrome after the user dismisses a terminal banner.
   */
  function clearStream() {
    dispatch({ type: 'reset' });
  }

  const isBusy = stream.phase === 'posting' || stream.phase === 'streaming';

  return {
    stream,
    isBusy,
    send,
    retry,
    stop,
    clearStream,
  };
}
