/**
 * Queued chat questions while project knowledge is updating — persist 202 rows,
 * resume after validated publish, and fail on TTL / writer cancel / recovery exhaustion.
 */
import { loadConfig } from '../../platform/config.js';
import { Message } from '../../models/messages.model.js';
import { caughtErrorFields } from '../../platform/errors.js';
import { assertKnowledgeReadable } from '../knowledge/index.js';
import { ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import { findActiveJobForProjectByTypes } from '../masters/index.js';
import { persistOpenClarificationSetFromInterrupt } from './clarification.js';
import { findActiveProjectWriterLockJobId } from '../../worker/projectLock.js';
import { invokeChatGraph, buildChatGraphThreadId, createMongoChatCheckpointer } from './chatGraph.js';
import {
  insertQueuedUserMessage,
  markQueuedMessagesFailed,
  claimQueuedMessageForResume,
  listUnexpiredQueuedMessages,
  insertAssistantForExistingUser,
  markExpiredQueuedMessagesFailed,
  finalizeAssistantMessage as finalizeAssistantMessageInRepo,
} from './conversation.helper.js';

/** Time a question may wait behind a knowledge update before failing retryable (30 min). */
export const QUEUED_MESSAGE_TTL_MS = 1_800_000;

/** How often the worker fails expired queued rows. */
export const QUEUED_MESSAGE_SWEEP_INTERVAL_MS = 60_000;

/** Max queued messages resumed per publish notification. */
export const QUEUED_MESSAGE_BATCH_SIZE = 20;

/** Job types that hold the per-project graph writer. */
export const KNOWLEDGE_WRITER_JOB_TYPES = Object.freeze(['project_knowledge_build', 'project_knowledge_rebuild', 'connected_repo_pull']);

/**
 * Resolves the active writer job id for a project (lock first, then active writer jobs).
 * @param {{ orgId: string, projectId: string }} scope Project scope.
 * @returns {Promise<string | null>}
 */
export async function resolveWriterJobId(scope) {
  const lockJobId = await findActiveProjectWriterLockJobId({
    orgId: scope.orgId,
    projectId: scope.projectId,
  });
  if (lockJobId) {
    return lockJobId;
  }
  const job = await findActiveJobForProjectByTypes(scope.orgId, scope.projectId, [...KNOWLEDGE_WRITER_JOB_TYPES]);
  return job?._id ? String(job._id) : null;
}

/**
 * Persists a queued user message and returns the 202 body fields.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   conversationId: string,
 *   actorUserId: string,
 *   content: string,
 * }} input Queue inputs.
 * @returns {Promise<{
 *   messageId: string,
 *   jobId: string | null,
 *   messageStatus: 'queued',
 *   queuedAt: string,
 *   expiresAt: string,
 * }>}
 */
export async function enqueueChatMessageWhileKnowledgeUpdating(input) {
  const queuedAt = new Date();
  const expiresAt = new Date(queuedAt.getTime() + QUEUED_MESSAGE_TTL_MS);
  const jobId = await resolveWriterJobId({ orgId: input.orgId, projectId: input.projectId });
  const userMessage = await insertQueuedUserMessage({
    orgId: input.orgId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    actorUserId: input.actorUserId,
    content: input.content,
    blockingJobId: jobId,
    queuedAt,
    expiresAt,
  });
  return {
    messageId: String(userMessage._id),
    jobId,
    messageStatus: /** @type {'queued'} */ ('queued'),
    queuedAt: queuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Drains unexpired queued messages after validated knowledge publish (S6 callback).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   knowledgeVersionId: string,
 *   log?: { error?: Function, info?: Function, warn?: Function },
 *   workspaceRoot?: string,
 * }} input Publish scope.
 * @returns {Promise<{ resumed: number, failed: number, skipped: number }>}
 */
export async function notifyKnowledgePublished(input) {
  const now = new Date();
  const rows = await listUnexpiredQueuedMessages({
    orgId: input.orgId,
    projectId: input.projectId,
    now,
    limit: QUEUED_MESSAGE_BATCH_SIZE,
  });
  if (rows.length === 0) {
    return { resumed: 0, failed: 0, skipped: 0 };
  }

  let resumed = 0;
  let failed = 0;
  let skipped = 0;
  const workspaceRoot = input.workspaceRoot ?? loadConfig().workspace.root;

  for (const row of rows) {
    const claimed = await claimQueuedMessageForResume({
      orgId: input.orgId,
      messageId: String(row._id),
      knowledgeVersionId: input.knowledgeVersionId,
      now,
    });
    if (!claimed) {
      skipped += 1;
      continue;
    }

    const gate = await assertKnowledgeReadable({ orgId: input.orgId, projectId: input.projectId });
    if (gate.action !== 'allow') {
      // Claim already moved status off queued — fail this row directly.
      await failClaimedUserMessage(claimed, input.log);
      failed += 1;
      continue;
    }

    try {
      await resumeClaimedQueuedMessage({
        claimed,
        knowledgeVersionId: gate.knowledgeVersionId ?? input.knowledgeVersionId,
        workspaceRoot,
        log: input.log,
      });
      resumed += 1;
    } catch (error) {
      input.log?.error?.(
        {
          ...caughtErrorFields(error),
          messageId: String(claimed._id),
          projectId: String(input.projectId),
        },
        'queued chat resume failed',
      );
      failed += 1;
    }
  }

  return { resumed, failed, skipped };
}

/**
 * Marks all queued messages for a project failed (recovery exhausted / writer cancel).
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   reason?: string,
 *   log?: { info?: Function },
 * }} input Fail scope.
 * @returns {Promise<number>} Modified count.
 */
export async function failQueuedMessagesForProject(input) {
  const modified = await markQueuedMessagesFailed({
    orgId: input.orgId,
    projectId: input.projectId,
    queueFailureCode: 'KNOWLEDGE_UNAVAILABLE',
  });
  input.log?.info?.(
    {
      orgId: String(input.orgId),
      projectId: String(input.projectId),
      reason: input.reason ?? 'unspecified',
      modified,
    },
    'queued chat messages failed for project',
  );
  return modified;
}

/**
 * Fails expired queued messages across all tenants (worker tick).
 * @param {{ log?: { info?: Function, error?: Function } }} [input] Optional logger.
 * @returns {Promise<number>} Modified count.
 */
export async function sweepExpiredQueuedMessages(input = {}) {
  try {
    const modified = await markExpiredQueuedMessagesFailed({ now: new Date() });
    if (modified > 0) {
      input.log?.info?.({ modified }, 'expired queued chat messages failed');
    }
    return modified;
  } catch (error) {
    input.log?.error?.({ ...caughtErrorFields(error) }, 'queued chat expiry sweep failed');
    throw error;
  }
}

/**
 * True when a job type holds the graph writer (cancel/fail should fail the chat queue).
 * @param {string | null | undefined} jobType Job type.
 * @returns {boolean}
 */
export function isKnowledgeWriterJobType(jobType) {
  return typeof jobType === 'string' && KNOWLEDGE_WRITER_JOB_TYPES.includes(jobType);
}

/**
 * Marks a claimed (accepted) user message failed when resume cannot proceed.
 * @param {import('mongoose').Document} claimed Claimed user message.
 * @param {{ error?: Function }} [log] Logger.
 * @returns {Promise<void>}
 */
async function failClaimedUserMessage(claimed, log) {
  try {
    await Message.findOneAndUpdate(
      { _id: claimed._id, orgId: claimed.orgId, status: ROW_STATUS_ACTIVE },
      {
        $set: {
          messageStatus: 'failed',
          queueFailureCode: 'KNOWLEDGE_UNAVAILABLE',
          queuedAt: null,
          expiresAt: null,
          blockingJobId: null,
        },
      },
    ).exec();
  } catch (error) {
    log?.error?.({ ...caughtErrorFields(error), messageId: String(claimed._id) }, 'failed to mark claimed queued message failed');
  }
}

/**
 * Inserts an assistant sibling and runs LangGraph headless for one claimed queued message.
 * @param {{
 *   claimed: import('mongoose').Document,
 *   knowledgeVersionId: string,
 *   workspaceRoot: string,
 *   log?: { error?: Function },
 * }} input Resume inputs.
 * @returns {Promise<void>}
 */
async function resumeClaimedQueuedMessage(input) {
  const claimed = input.claimed;
  const orgId = String(claimed.orgId);
  const projectId = String(claimed.projectId);
  const conversationId = String(claimed.conversationId);
  const userMessageId = String(claimed._id);
  const actorUserId = claimed.createdBy ? String(claimed.createdBy) : null;

  const assistant = await insertAssistantForExistingUser({
    orgId,
    projectId,
    conversationId,
    userMessageId,
    actorUserId,
    knowledgeVersionId: input.knowledgeVersionId,
  });
  const assistantMessageId = String(assistant._id);

  const threadId = buildChatGraphThreadId(orgId, conversationId, assistantMessageId);
  const checkpointer = createMongoChatCheckpointer();

  /** @type {string} */
  let terminalStatus = 'completed';
  /** @type {boolean} */
  let sawDone = false;

  try {
    const result = await invokeChatGraph({
      threadId,
      checkpointer,
      log: input.log,
      input: {
        scope: {
          orgId,
          projectId,
          conversationId,
          userId: actorUserId,
          userMessageId,
          assistantMessageId,
          knowledgeVersionId: String(input.knowledgeVersionId),
          correlationId: `queued-resume:${userMessageId}`,
          workspaceRoot: input.workspaceRoot,
        },
        question: claimed.content,
      },
      onStage: () => {},
      onDelta: () => {},
      onEvidence: () => {},
      onDone: () => {
        sawDone = true;
        terminalStatus = 'completed';
      },
      onError: () => {
        terminalStatus = 'failed';
      },
    });

    if (result?.__interrupt__) {
      const clarificationSet = result.__interrupt__[0]?.value;
      if (clarificationSet) {
        await persistOpenClarificationSetFromInterrupt({
          orgId,
          projectId,
          conversationId,
          messageId: assistantMessageId,
          actorUserId,
          clarificationSet,
        });
      }
      await finalizeAssistantMessageInRepo({
        orgId,
        projectId,
        conversationId,
        assistantMessageId,
        content: '',
        messageStatus: 'awaiting_clarification',
        updatedBy: actorUserId,
      });
      return;
    }

    if (!sawDone && terminalStatus !== 'failed') {
      await finalizeAssistantMessageInRepo({
        orgId,
        projectId,
        conversationId,
        assistantMessageId,
        content: typeof result?.answerContent === 'string' ? result.answerContent : '',
        messageStatus: result?.supportLevel === 'insufficient' || result?.route === 'abstain_early' ? 'abstained' : 'completed',
        updatedBy: actorUserId,
        knowledgeVersionId: input.knowledgeVersionId,
      });
    }
  } catch (error) {
    try {
      await finalizeAssistantMessageInRepo({
        orgId,
        projectId,
        conversationId,
        assistantMessageId,
        content: '',
        messageStatus: 'failed',
        updatedBy: actorUserId,
      });
    } catch (persistError) {
      input.log?.error?.({ ...caughtErrorFields(persistError) }, 'queued resume failed to mark assistant failed');
    }
    throw error;
  }
}
