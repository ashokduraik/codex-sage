/**
 * Public surface of the conversation module.
 */
import { Message } from '../../models/messages.model.js';
import { Conversation } from '../../models/conversations.model.js';
import { ChatCheckpoint } from '../../models/chatCheckpoint.model.js';
import { ClarificationSet } from '../../models/clarificationSet.model.js';

export {
  refreshConversationSearchText,
  archiveConversation,
  assertConversationWritable,
  createConversation,
  deleteConversation,
  finalizeAssistantMessage,
  getConversation,
  getConversationHttp,
  listConversationMessagesHttp,
  listConversationsHttp,
  searchConversationsHttp,
  listConversationMessages,
  listConversations,
  listRecentMessages,
  loadConversationForUser,
  mapConversationToDto,
  mapConversationToListDto,
  mapConversationToSearchDto,
  mapMessageToDto,
  renameConversationHttp,
  archiveConversationHttp,
  restoreConversationHttp,
  createConversationHttp,
  restoreConversation,
  scheduleConversationAutoTitle,
  searchConversations,
  updateConversationTitle,
  deleteConversationHttp,
} from './conversation.js';
export {
  CHAT_MESSAGE_CONTENT_MAX_LENGTH,
  SSE_KEEPALIVE_INTERVAL_MS,
  acceptIncludesEventStream,
  formatSseEvent,
  streamConversationMessageHttp,
  runChatMessageStream,
} from './chatStream.js';
export {
  CLARIFICATION_FREE_TEXT_MAX_LENGTH,
  answerClarificationHttp,
  persistOpenClarificationSetFromInterrupt,
  loadOpenClarificationsForMessages,
  validateClarificationAnswers,
} from './clarification.js';
export { ClarificationSet } from '../../models/clarificationSet.model.js';
export {
  QUEUED_MESSAGE_TTL_MS,
  QUEUED_MESSAGE_BATCH_SIZE,
  KNOWLEDGE_WRITER_JOB_TYPES,
  QUEUED_MESSAGE_SWEEP_INTERVAL_MS,
  resolveWriterJobId,
  isKnowledgeWriterJobType,
  notifyKnowledgePublished,
  failQueuedMessagesForProject,
  sweepExpiredQueuedMessages,
  enqueueChatMessageWhileKnowledgeUpdating,
} from './chatQueue.js';
export { COMPACTION_MAX_PASSES, EXCERPT_MIN_TOKENS, RESERVED_OUTPUT_TOKENS, getContextBudgetConfig, prepareModelInput } from './contextBudgeter.js';
export {
  INFERENCE_QUEUE_MAX_CONCURRENCY,
  INFERENCE_QUEUE_MAX_DEPTH,
  assertLlmAvailable,
  generateText,
  getLlmConfigStatus,
  streamText,
} from './llm.js';
export { executeTool, listToolDefinitionsForSchema } from './agentTools.js';
export { assertRunBudget, getRunBudgetConfig } from './runBudget.js';
export {
  PINNED_FACTS_MAX_COUNT,
  RECENT_TURNS_MAX_COUNT,
  SUMMARY_TEXT_MAX_CHARS,
  applySummaryFromCompaction,
  buildConversationContext,
  getConversationContextHttp,
  persistMessageContextMetrics,
  pinFact,
  unpinFact,
  updateConversationSummary,
} from './conversationContext.js';
export { Message } from '../../models/messages.model.js';
export { ChatCheckpoint } from '../../models/chatCheckpoint.model.js';
export {
  CHAT_GRAPH_STAGE_VALUES,
  CLARIFICATION_MAX_ROUNDS,
  MAX_VERIFY_REVISE,
  buildChatGraphThreadId,
  compileChatGraph,
  createMongoChatCheckpointer,
  invokeChatGraph,
  parseChatGraphThreadId,
  resumeChatGraphFromClarification,
  runDeterministicVerify,
  toolChoiceDecisionSchema,
  understandDecisionSchema,
} from './chatGraph.js';

/** Models whose indexes are synced on development API startup. */
export const CONVERSATION_MODELS = Object.freeze([Conversation, Message, ChatCheckpoint, ClarificationSet]);
