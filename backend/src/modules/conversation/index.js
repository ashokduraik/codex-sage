/**
 * Public surface of the conversation module.
 */
export {
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
export { Message } from '../../models/messages.model.js';

import { Conversation } from '../../models/conversations.model.js';
import { Message } from '../../models/messages.model.js';

/** Models whose indexes are synced on development API startup. */
export const CONVERSATION_MODELS = Object.freeze([Conversation, Message]);
