/**
 * Automatic title policy — no LLM until Phase 45.
 */
import {
  CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS,
  CONVERSATION_TRUNCATED_TITLE_MAX_CHARS,
} from './conversations.constants.js';
import {
  findConversationInProject,
  refreshConversationSearchText,
  updateConversationTitleFields,
} from './conversations.repository.js';

/**
 * Truncates user text into a title-safe string.
 * @param {string} text Source text.
 * @param {number} maxChars Cap.
 * @returns {string}
 */
export function truncateUserTextTitle(text, maxChars) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return '';
  }
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return collapsed.slice(0, maxChars).trimEnd();
}

/**
 * Sets a truncated first-user-message title when the row still has the default title.
 * Does not call a model. Missing rows and non-default titles are no-ops so `done` is never blocked.
 * @param {{
 *   orgId: import('mongoose').Types.ObjectId | string,
 *   projectId: string,
 *   conversationId: string,
 *   firstUserContent?: string,
 *   assistantMessageId?: string,
 * }} input Auto-title inputs.
 * @returns {Promise<void>}
 */
export async function scheduleConversationAutoTitle(input) {
  const raw =
    typeof input.firstUserContent === 'string'
      ? input.firstUserContent.slice(0, CONVERSATION_AUTO_TITLE_MAX_INPUT_CHARS)
      : '';
  const title = truncateUserTextTitle(raw, CONVERSATION_TRUNCATED_TITLE_MAX_CHARS);
  if (!title) {
    return;
  }

  const conversation = await findConversationInProject(
    input.orgId,
    input.projectId,
    input.conversationId,
  );
  if (!conversation || conversation.titleSource !== 'default') {
    return;
  }

  await updateConversationTitleFields({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    title,
    titleSource: 'truncated_user_text',
  });
  await refreshConversationSearchText({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
  });
}
