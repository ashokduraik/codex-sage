/**
 * Clarification answer transport — POST all answers once and resume the paused run over SSE.
 */
import { postChatStream } from '@/features/chat/api/chatStreamApi.js';

/** Client mirror of backend free-text answer cap (server remains authoritative). */
export const CLARIFICATION_FREE_TEXT_MAX_LENGTH = 2000;

/**
 * Submits every answer for an open clarification set and consumes the resume SSE stream.
 * @param {{
 *   projectId: string,
 *   conversationId: string,
 *   messageId: string,
 *   clarificationSetId: string,
 *   answers: Record<string, string | string[]>,
 *   idempotencyKey: string,
 *   signal?: AbortSignal,
 *   onEvent?: (frame: { event: string, data: unknown }) => void,
 * }} input Answer + stream options.
 * @returns {Promise<{ kind: 'stream', terminal: 'done' | 'error' | 'interrupted' | 'cancelled' | 'awaiting_clarification', messageId?: string, error?: object } | { kind: 'queued', body: object }>}
 */
export async function answerClarificationStream(input) {
  return postChatStream('/conversation/clarification/answer', {
    body: {
      projectId: input.projectId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      clarificationSetId: input.clarificationSetId,
      answers: input.answers,
    },
    idempotencyKey: input.idempotencyKey,
    signal: input.signal,
    onEvent: input.onEvent,
  });
}
