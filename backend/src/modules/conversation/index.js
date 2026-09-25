/**
 * Public surface of the conversation module.
 */
export {
  CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS,
  CONVERSATION_DEFAULT_TITLE,
  CONVERSATION_LIFECYCLE_STATUS_VALUES,
  CONVERSATION_SEARCH_DEFAULT_LIMIT,
  CONVERSATION_SEARCH_MAX_LIMIT,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
  CONVERSATION_SEARCH_SNIPPET_MAX_CHARS,
  CONVERSATION_SEARCH_TEXT_MAX_CHARS,
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_TITLE_SOURCE_VALUES,
  CONVERSATION_TRUNCATED_TITLE_MAX_CHARS,
  CONVERSATIONS_LIST_DEFAULT_LIMIT,
  CONVERSATIONS_LIST_MAX_LIMIT,
  MESSAGE_ROLE_VALUES,
  MESSAGE_STATUS_VALUES,
  MESSAGES_LIST_DEFAULT_LIMIT,
  MESSAGES_LIST_MAX_LIMIT,
  buildOwnConversationFilter,
  refreshConversationSearchText,
  archiveConversation,
  assertConversationArchiveAllowed,
  assertConversationRestoreAllowed,
  assertConversationWritable,
  createConversation,
  deleteConversation,
  getConversation,
  listConversationMessages,
  listConversations,
  listRecentMessages,
  loadConversationForUser,
  mapConversationToDto,
  mapConversationToListDto,
  mapConversationToSearchDto,
  mapMessageToDto,
  restoreConversation,
  scheduleConversationAutoTitle,
  searchConversations,
  truncateUserTextTitle,
  updateConversationTitle,
  conversationRoutes,
} from './conversation.js';
export { Conversation } from '../../models/conversations.model.js';
export { Message } from '../../models/messages.model.js';

import { Conversation } from '../../models/conversations.model.js';
import { Message } from '../../models/messages.model.js';

/** Models whose indexes are synced on development API startup. */
export const CONVERSATION_MODELS = Object.freeze([Conversation, Message]);
