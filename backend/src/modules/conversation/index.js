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
export {
  COMPACTION_MAX_PASSES,
  EXCERPT_MIN_TOKENS,
  RESERVED_OUTPUT_TOKENS,
  createTokenizerAdapter,
  getContextBudgetConfig,
  prepareModelInput,
} from './contextBudgeter.js';
export {
  INFERENCE_QUEUE_MAX_CONCURRENCY,
  INFERENCE_QUEUE_MAX_DEPTH,
  assertLlmAvailable,
  generateText,
  getLlmConfigStatus,
  streamText,
} from './llm.js';
export {
  PINNED_FACTS_MAX_COUNT,
  RECENT_TURNS_MAX_COUNT,
  SUMMARY_TEXT_MAX_CHARS,
  applySummaryFromCompaction,
  buildConversationContext,
  conversationContextRoutes,
  persistMessageContextMetrics,
  pinFact,
  unpinFact,
  updateConversationSummary,
} from './conversationContext.js';
export { Message } from '../../models/messages.model.js';

import { Conversation } from '../../models/conversations.model.js';
import { Message } from '../../models/messages.model.js';

/** Models whose indexes are synced on development API startup. */
export const CONVERSATION_MODELS = Object.freeze([Conversation, Message]);
