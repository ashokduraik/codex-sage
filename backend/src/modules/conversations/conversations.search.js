/**
 * Conversation search snippets and query helpers.
 */
import { ApiError } from '../../platform/errors.js';
import {
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
  CONVERSATION_SEARCH_SNIPPET_MAX_CHARS,
} from './conversations.constants.js';

/**
 * Normalizes and validates a search query string.
 * @param {unknown} raw Raw `q` value.
 * @returns {string}
 * @throws {import('../../platform/errors.js').ApiError} VALIDATION_ERROR
 */
export function parseConversationSearchQuery(raw) {
  if (typeof raw !== 'string') {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [{ path: 'q', message: 'q is required' }],
    });
  }
  const query = raw.trim();
  if (query.length < CONVERSATION_SEARCH_MIN_QUERY_LENGTH) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      details: [
        {
          path: 'q',
          message: `q must be at least ${CONVERSATION_SEARCH_MIN_QUERY_LENGTH} characters`,
        },
      ],
    });
  }
  return query;
}

/**
 * Builds a plain-text snippet from title or searchText, capped and ellipsized.
 * @param {{ title?: string, searchText?: string }} conversation Conversation fields.
 * @param {string} query Search query.
 * @param {number} [maxChars] Snippet cap.
 * @returns {string}
 */
export function buildConversationSnippet(conversation, query, maxChars) {
  const cap = maxChars ?? CONVERSATION_SEARCH_SNIPPET_MAX_CHARS;
  const title = typeof conversation.title === 'string' ? conversation.title : '';
  const searchText = typeof conversation.searchText === 'string' ? conversation.searchText : '';
  const needle = query.toLowerCase();
  const source = title.toLowerCase().includes(needle) ? title : searchText || title;
  if (source.length <= cap) {
    return source;
  }
  if (cap <= 3) {
    return source.slice(0, cap);
  }
  return `${source.slice(0, cap - 3)}...`;
}
