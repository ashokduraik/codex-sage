/**
 * Named limits for conversation list, messages, titles, and search.
 */

/** Default page size for conversation lists. */
export const CONVERSATIONS_LIST_DEFAULT_LIMIT = 20;

/** Upper bound for conversation list pages. */
export const CONVERSATIONS_LIST_MAX_LIMIT = 100;

/** Default page size for message lists. */
export const MESSAGES_LIST_DEFAULT_LIMIT = 50;

/** Upper bound for message list pages. */
export const MESSAGES_LIST_MAX_LIMIT = 200;

/** Maximum stored conversation title length. */
export const CONVERSATION_TITLE_MAX_LENGTH = 200;

/** Placeholder title until the user renames or auto-title runs. */
export const CONVERSATION_DEFAULT_TITLE = 'New conversation';

/** Minimum search query length. */
export const CONVERSATION_SEARCH_MIN_QUERY_LENGTH = 2;

/** Default search page size. */
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 20;

/** Maximum search page size. */
export const CONVERSATION_SEARCH_MAX_LIMIT = 100;

/** Snippet character cap (plain text, no highlight markers). */
export const CONVERSATION_SEARCH_SNIPPET_MAX_CHARS = 160;

/** Cap for denormalized message text on the conversation row. */
export const CONVERSATION_SEARCH_TEXT_MAX_CHARS = 8000;

/** Cap for a future LLM auto-title prompt (Phase 45). */
export const CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS = 500;

/** Interim title from the first user message when titleSource is still default. */
export const CONVERSATION_TRUNCATED_TITLE_MAX_CHARS = 60;

/** Conversation lifecycle values (not row status). */
export const CONVERSATION_LIFECYCLE_STATUS_VALUES = Object.freeze(['active', 'archived']);

/** How the current title was produced. */
export const CONVERSATION_TITLE_SOURCE_VALUES = Object.freeze([
  'default',
  'user',
  'truncated_user_text',
  'llm',
]);

/** Message roles stored on rows. */
export const MESSAGE_ROLE_VALUES = Object.freeze(['user', 'assistant', 'system']);

/** Message processing statuses (Phase 50 extends this enum). */
export const MESSAGE_STATUS_VALUES = Object.freeze(['completed']);
