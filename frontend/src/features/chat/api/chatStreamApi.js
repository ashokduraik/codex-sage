/**
 * Chat SSE transport — POST stream/retry with Accept: text/event-stream and frame parsing.
 * JSON apiRequest cannot consume SSE bodies; this module owns auth + Idempotency-Key + stream read.
 */
import i18n from '@/shared/i18n';
import { API_BASE_URL } from '@/shared/api/apiConfig.js';
import { refreshAccessToken } from '@/shared/api/refreshClient.js';
import { clearSession, getAccessToken } from '@/shared/api/apiSession.js';
import { ApiError, apiErrorFromNetworkFailure, apiErrorFromResponse, isRequestAbortedError, RequestAbortedError } from '@/shared/api/ApiError.js';

/** SSE event names allowed by architecture §9. */
export const CHAT_SSE_EVENTS = Object.freeze(['status', 'delta', 'clarification', 'evidence', 'done', 'error']);

/** Graph/transport stages mapped to i18n (unknown → working). */
export const CHAT_STAGE_I18N_KEYS = Object.freeze({
  accepted: 'chat.stages.accepted',
  understanding_question: 'chat.stages.understandingQuestion',
  searching_code: 'chat.stages.searchingCode',
  reviewing_sources: 'chat.stages.reviewingSources',
  generating_answer: 'chat.stages.generatingAnswer',
  verifying_answer: 'chat.stages.verifyingAnswer',
  awaiting_clarification: 'chat.stages.awaitingClarification',
  abstain_early: 'chat.stages.abstainEarly',
  composing_reply: 'chat.stages.composingReply',
  generating: 'chat.stages.generatingAnswer',
});

/**
 * Maps a backend status stage to an i18n key.
 * @param {string | undefined} stage Stage from SSE status event.
 * @returns {string} i18n key (never invents chain-of-thought copy).
 */
export function stageToI18nKey(stage) {
  if (typeof stage === 'string' && CHAT_STAGE_I18N_KEYS[stage]) {
    return CHAT_STAGE_I18N_KEYS[stage];
  }
  return 'chat.stages.working';
}

/**
 * Creates an incremental SSE frame parser for chunked ReadableStream text.
 * @returns {{ push: (chunk: string) => Array<{ event: string, data: unknown }>, flush: () => Array<{ event: string, data: unknown }> }}
 */
export function createSseParser() {
  let buffer = '';

  /**
   * Parses complete frames from the buffer.
   * @param {boolean} flushRemainder Whether to treat remaining buffer as a final frame.
   * @returns {Array<{ event: string, data: unknown }>}
   */
  function drain(flushRemainder) {
    /** @type {Array<{ event: string, data: unknown }>} */
    const frames = [];
    const parts = buffer.split('\n\n');
    if (!flushRemainder) {
      buffer = parts.pop() ?? '';
    } else {
      buffer = '';
    }
    for (const block of parts) {
      if (!block || block.startsWith(':')) {
        continue;
      }
      let eventName = 'message';
      /** @type {string[]} */
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length === 0) {
        continue;
      }
      const raw = dataLines.join('\n');
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw };
      }
      frames.push({ event: eventName, data });
    }
    return frames;
  }

  return {
    /**
     * Appends a text chunk and returns newly completed frames.
     * @param {string} chunk UTF-8 text from the stream.
     * @returns {Array<{ event: string, data: unknown }>}
     */
    push(chunk) {
      buffer += chunk;
      return drain(false);
    },
    /**
     * Flushes any trailing incomplete frame after the stream ends.
     * @returns {Array<{ event: string, data: unknown }>}
     */
    flush() {
      return drain(true);
    },
  };
}

/**
 * Posts a chat question and consumes the SSE body (or returns a 202 queued payload).
 * @param {{
 *   projectId: string,
 *   conversationId: string,
 *   content: string,
 *   idempotencyKey: string,
 *   signal?: AbortSignal,
 *   onEvent?: (frame: { event: string, data: unknown }) => void,
 * }} input Stream inputs.
 * @returns {Promise<{ kind: 'stream', terminal: 'done' | 'error' | 'interrupted' | 'cancelled' | 'awaiting_clarification', messageId?: string, error?: object } | { kind: 'queued', body: object }>}
 */
export async function streamConversationMessage(input) {
  const path = `/conversation/chatStream/streamMessage/${encodeURIComponent(input.projectId)}/${encodeURIComponent(input.conversationId)}`;
  return postChatStream(path, {
    body: { content: input.content },
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
    onEvent: input.onEvent,
  });
}

/**
 * Retries a failed/interrupted assistant message over SSE (or 202 queue).
 * @param {{
 *   projectId: string,
 *   conversationId: string,
 *   messageId: string,
 *   idempotencyKey: string,
 *   signal?: AbortSignal,
 *   onEvent?: (frame: { event: string, data: unknown }) => void,
 * }} input Retry inputs.
 * @returns {Promise<{ kind: 'stream', terminal: 'done' | 'error' | 'interrupted' | 'cancelled' | 'awaiting_clarification', messageId?: string, error?: object } | { kind: 'queued', body: object }>}
 */
export async function retryConversationMessage(input) {
  const path = `/conversation/chatStream/retryMessage/${encodeURIComponent(input.projectId)}/${encodeURIComponent(input.conversationId)}/${encodeURIComponent(input.messageId)}`;
  return postChatStream(path, {
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
    onEvent: input.onEvent,
  });
}

/**
 * Shared POST + Accept event-stream with optional JSON body (ask, retry, clarification answer).
 * @param {string} path API path under base URL.
 * @param {{
 *   body?: object,
 *   idempotencyKey: string,
 *   signal?: AbortSignal,
 *   onEvent?: (frame: { event: string, data: unknown }) => void,
 *   skipAuthRefresh?: boolean,
 * }} options Request options.
 * @returns {Promise<{ kind: 'stream', terminal: 'done' | 'error' | 'interrupted' | 'cancelled' | 'awaiting_clarification', messageId?: string, error?: object } | { kind: 'queued', body: object }>}
 */
export async function postChatStream(path, options) {
  return executeChatStream(path, options, false);
}

/**
 * Executes the stream POST with one 401 refresh retry before headers are consumed.
 * @param {string} path API path.
 * @param {{
 *   body?: object,
 *   idempotencyKey: string,
 *   signal?: AbortSignal,
 *   onEvent?: (frame: { event: string, data: unknown }) => void,
 *   skipAuthRefresh?: boolean,
 * }} options Request options.
 * @param {boolean} hasRetriedAfterRefresh Whether refresh already ran.
 * @returns {Promise<{ kind: 'stream', terminal: 'done' | 'error' | 'interrupted' | 'cancelled' | 'awaiting_clarification', messageId?: string, error?: object } | { kind: 'queued', body: object }>}
 */
async function executeChatStream(path, options, hasRetriedAfterRefresh) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'text/event-stream',
    'Accept-Language': i18n.language || 'en',
    'Idempotency-Key': options.idempotencyKey,
  };
  const token = getAccessToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  /** @type {RequestInit} */
  const init = {
    method: 'POST',
    headers,
    credentials: 'include',
    signal: options.signal,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path.startsWith('/') ? `${API_BASE_URL}${path}` : `${API_BASE_URL}/${path}`, init);
  } catch (error) {
    if (isRequestAbortedError(error) || options.signal?.aborted) {
      throw error instanceof Error && error.name === 'AbortError' ? error : new RequestAbortedError();
    }
    throw apiErrorFromNetworkFailure();
  }

  if (response.status === 401 && !options.skipAuthRefresh && !hasRetriedAfterRefresh) {
    try {
      await refreshAccessToken();
    } catch (refreshError) {
      if (isRequestAbortedError(refreshError)) {
        throw refreshError;
      }
      let parsedBody;
      try {
        parsedBody = await response.clone().json();
      } catch {
        parsedBody = undefined;
      }
      throw apiErrorFromResponse(response, parsedBody);
    }
    return executeChatStream(path, options, true);
  }

  if (response.status === 401 && !options.skipAuthRefresh && hasRetriedAfterRefresh) {
    clearSession();
    let parsedBody;
    try {
      parsedBody = await response.json();
    } catch {
      parsedBody = undefined;
    }
    throw apiErrorFromResponse(response, parsedBody);
  }

  if (response.status === 202) {
    let body;
    try {
      body = await response.json();
    } catch {
      throw new ApiError({
        status: 202,
        code: 'UNEXPECTED',
        message: i18n.t('errors.unexpected'),
        correlationId: response.headers.get('X-Correlation-Id') ?? undefined,
      });
    }
    return { kind: 'queued', body };
  }

  if (!response.ok) {
    let parsedBody;
    try {
      parsedBody = await response.json();
    } catch {
      parsedBody = undefined;
    }
    throw apiErrorFromResponse(response, parsedBody);
  }

  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('text/event-stream')) {
    // Idempotent JSON replay of a prior stream outcome.
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    if (body && typeof body === 'object' && 'assistantMessageId' in body) {
      options.onEvent?.({
        event: 'done',
        data: { messageId: /** @type {{ assistantMessageId: string }} */ (body).assistantMessageId },
      });
      return {
        kind: 'stream',
        terminal: 'done',
        messageId: String(/** @type {{ assistantMessageId: string }} */ (body).assistantMessageId),
      };
    }
  }

  return readSseResponse(response, options);
}

/**
 * Reads an SSE response body and invokes onEvent for each frame.
 * @param {Response} response Fetch response with a body stream.
 * @param {{
 *   signal?: AbortSignal,
 *   onEvent?: (frame: { event: string, data: unknown }) => void,
 * }} options Stream callbacks.
 * @returns {Promise<{ kind: 'stream', terminal: 'done' | 'error' | 'interrupted' | 'cancelled' | 'awaiting_clarification', messageId?: string, error?: object }>}
 */
async function readSseResponse(response, options) {
  if (!response.body) {
    throw new ApiError({
      status: response.status,
      code: 'UNEXPECTED',
      message: i18n.t('errors.unexpected'),
      correlationId: response.headers.get('X-Correlation-Id') ?? undefined,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  /** @type {'done' | 'error' | 'interrupted' | 'cancelled' | 'awaiting_clarification' | null} */
  let terminal = null;
  /** @type {string | undefined} */
  let messageId;
  /** @type {object | undefined} */
  let errorPayload;
  /** @type {boolean} */
  let sawClarification = false;

  /**
   * Dispatches parsed frames and updates terminal state.
   * @param {Array<{ event: string, data: unknown }>} frames Frames.
   */
  function handleFrames(frames) {
    for (const frame of frames) {
      if (!CHAT_SSE_EVENTS.includes(frame.event)) {
        continue;
      }
      options.onEvent?.(frame);
      if (frame.event === 'done') {
        terminal = 'done';
        const data = frame.data && typeof frame.data === 'object' ? /** @type {{ messageId?: unknown }} */ (frame.data) : null;
        if (data && typeof data.messageId === 'string') {
          messageId = data.messageId;
        }
      } else if (frame.event === 'error') {
        terminal = 'error';
        errorPayload = frame.data && typeof frame.data === 'object' ? /** @type {object} */ (frame.data) : { message: String(frame.data) };
      } else if (frame.event === 'clarification') {
        sawClarification = true;
        const data = frame.data && typeof frame.data === 'object' ? /** @type {{ messageId?: unknown }} */ (frame.data) : null;
        if (data && typeof data.messageId === 'string') {
          messageId = data.messageId;
        }
      }
    }
  }

  try {
    for (;;) {
      if (options.signal?.aborted) {
        terminal = 'cancelled';
        try {
          await reader.cancel();
        } catch {
          // ignore cancel errors
        }
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        handleFrames(parser.flush());
        break;
      }
      handleFrames(parser.push(decoder.decode(value, { stream: true })));
      if (terminal === 'done' || terminal === 'error') {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
    }
  } catch (error) {
    if (isRequestAbortedError(error) || options.signal?.aborted) {
      return { kind: 'stream', terminal: 'cancelled' };
    }
    throw error;
  }

  if (terminal === 'done' || terminal === 'error' || terminal === 'cancelled') {
    return { kind: 'stream', terminal, messageId, error: errorPayload };
  }
  if (sawClarification) {
    return { kind: 'stream', terminal: 'awaiting_clarification', messageId, error: errorPayload };
  }
  return { kind: 'stream', terminal: 'interrupted', messageId, error: errorPayload };
}
