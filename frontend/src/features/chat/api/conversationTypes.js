/**
 * Conversation and message DTO typedefs for the chat feature.
 * Known enum values are documented; runtime may include unknown strings — never crash on them.
 */

/**
 * @typedef {'active' | 'archived' | string} ConversationLifecycleStatus
 */

/**
 * @typedef {'default' | 'user' | 'truncated_user_text' | 'llm' | string} ConversationTitleSource
 */

/**
 * @typedef {'user' | 'assistant' | 'system' | string} MessageRole
 */

/**
 * @typedef {'queued' | 'accepted' | 'generating' | 'awaiting_clarification' | 'completed' |
 *   'abstained' | 'failed' | 'interrupted' | string} MessageStatus
 */

/**
 * @typedef {object} ConversationListItemDto
 * @property {string} id Conversation id.
 * @property {string} title Display title.
 * @property {ConversationLifecycleStatus} lifecycleStatus Active vs archived.
 * @property {number} messageCount Denormalized turn count.
 * @property {string | null} lastMessageAt ISO last-message stamp, or null.
 * @property {string} updatedAt ISO updated stamp.
 */

/**
 * @typedef {object} ConversationDto
 * @property {string} id Conversation id.
 * @property {string} projectId Owning project id.
 * @property {string} title Display title.
 * @property {ConversationTitleSource} titleSource How the title was set.
 * @property {ConversationLifecycleStatus} lifecycleStatus Active vs archived.
 * @property {string} ownerUserId Owner user id.
 * @property {number} messageCount Denormalized turn count.
 * @property {string | null} lastMessageAt ISO last-message stamp, or null.
 * @property {string | null} archivedAt ISO archive stamp, or null.
 * @property {string} createdAt ISO created stamp.
 * @property {string} updatedAt ISO updated stamp.
 */

/**
 * @typedef {object} ConversationSearchHitDto
 * @property {string} id Conversation id.
 * @property {string} title Display title.
 * @property {string} snippet Matching text snippet.
 * @property {string} updatedAt ISO updated stamp.
 * @property {ConversationTitleSource} [titleSource] Title provenance when present.
 */

/**
 * @typedef {object} ClarificationEmbedDto
 * @property {string} clarificationSetId Public set id matching SSE.
 * @property {number} roundIndex 0 or 1.
 * @property {Array<{ id: string, type: string, prompt: string, options?: string[], required?: boolean }>} questions Full set.
 */

/**
 * @typedef {'evidence_backed' | 'insufficient' | 'conflict' | 'partial' | string} SupportLevel
 */

/**
 * @typedef {object} EvidenceItemDto
 * @property {string} [evidenceId] Stable evidence id from the run.
 * @property {'code' | 'document' | string} [kind] Evidence kind.
 * @property {string} path Project-relative path.
 * @property {number} [startLine] Inclusive start line.
 * @property {number} [endLine] Inclusive end line.
 * @property {string} [heading] Document heading when present.
 * @property {string} [excerpt] Short excerpt shown in the list.
 * @property {boolean} [excludedFromGraph] True when the file is not graph knowledge.
 */

/**
 * @typedef {object} MessageUsageDto
 * @property {number | null} [inputTokens] Prompt tokens when reported.
 * @property {number | null} [outputTokens] Completion tokens when reported.
 * @property {number | null} [totalTokens] Total tokens when reported.
 */

/**
 * @typedef {object} MessageContextMetricsDto
 * @property {number} [contextPercentUsed] Fraction 0–1 of context budget used.
 * @property {number} [measuredInputTokens] Measured input tokens.
 * @property {number} [maximumInputBudget] Max input budget when present.
 */

/**
 * @typedef {object} MessageDto
 * @property {string} id Message id.
 * @property {MessageRole} role Turn author role.
 * @property {string} content Visible text.
 * @property {MessageStatus} messageStatus Turn lifecycle status.
 * @property {string} createdAt ISO created stamp.
 * @property {EvidenceItemDto[] | null} [evidence] Grounding evidence when present.
 * @property {MessageUsageDto | null} [usage] Token usage when present.
 * @property {MessageContextMetricsDto | null} [contextMetrics] Context budget metrics when present.
 * @property {number | null} [durationMs] End-to-end duration when present.
 * @property {object} [error] Catalog error when present.
 * @property {string} [queuedAt] Queue stamp when present.
 * @property {SupportLevel} [supportLevel] Grounding support level when present.
 * @property {string} [knowledgeVersionId] Knowledge version id when present.
 * @property {ClarificationEmbedDto} [clarification] Open set when awaiting_clarification.
 */

/**
 * @typedef {object} ConversationListPage
 * @property {ConversationListItemDto[]} items Page of conversations.
 * @property {string | null} nextCursor Keyset cursor for the next page, or null.
 */

/**
 * @typedef {object} ConversationSearchPage
 * @property {ConversationSearchHitDto[]} items Search hits.
 * @property {string | null} nextCursor Keyset cursor for the next page, or null.
 */

/**
 * @typedef {object} MessageListPage
 * @property {MessageDto[]} items Page of messages (oldest → newest).
 * @property {string | null} nextCursor Keyset cursor for newer messages, or null.
 */

/** Known conversation lifecycle statuses (runtime may still send unknown strings). */
export const KNOWN_CONVERSATION_LIFECYCLE_STATUSES = Object.freeze(['active', 'archived']);

/** Known message statuses (runtime may still send unknown strings). */
export const KNOWN_MESSAGE_STATUSES = Object.freeze([
  'queued',
  'accepted',
  'generating',
  'awaiting_clarification',
  'completed',
  'abstained',
  'failed',
  'interrupted',
]);

/** Known grounding support levels (runtime may still send unknown strings). */
export const KNOWN_SUPPORT_LEVELS = Object.freeze(['evidence_backed', 'insufficient', 'conflict', 'partial']);
