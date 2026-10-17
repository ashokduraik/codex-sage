/**
 * Overflow helpers for chatGraph: UNDERSTAND / tool-choice Zod schemas and the
 * Mongo LangGraph checkpointer (tenant + soft-delete). Used only by chatGraph.js.
 */
import { z } from 'zod';
import mongoose from 'mongoose';
import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { ChatCheckpoint } from '../../models/chatCheckpoint.model.js';
import { ROW_STATUS_ACTIVE, ROW_STATUS_DELETED } from '../../platform/data/index.js';

/** Initial clarify set is round 0; at most one follow-up (round 1). */
export const CLARIFICATION_MAX_ROUNDS = 2;

/** Clarification question types the UNDERSTAND model may emit. */
export const CLARIFICATION_QUESTION_TYPES = Object.freeze(['single_select', 'multi_select', 'free_text']);

/** Routes UNDERSTAND may choose (clarify uses needsClarification, not route). */
export const UNDERSTAND_ROUTE_VALUES = Object.freeze(['retrieve', 'abstain_early']);

/** Tool-choice actions for AGENT_TOOLS. */
export const TOOL_CHOICE_ACTION_VALUES = Object.freeze(['call_tool', 'finish_retrieval']);

/** Scoped agent tools the model may request (phase 46). */
export const AGENT_TOOL_NAME_VALUES = Object.freeze([
  'explore_code',
  'search_documents',
  'list_documents',
  'read_document_slice',
  'read_file_slice',
  'abstain',
]);

/**
 * Zod schema for the UNDERSTAND structured decision.
 * Extra keys are stripped; invalid route fails validation.
 */
export const understandDecisionSchema = z
  .object({
    rewrittenQuestion: z.string().min(1),
    needsClarification: z.boolean(),
    clarificationQuestions: z.array(
      z.object({
        id: z.string().min(1).optional(),
        type: z.enum(CLARIFICATION_QUESTION_TYPES),
        prompt: z.string().min(1),
        options: z.array(z.string()).optional(),
      }),
    ),
    route: z.enum(UNDERSTAND_ROUTE_VALUES),
  })
  .strict();

/**
 * Zod schema for AGENT_TOOLS tool-choice structured output.
 * `reason` is optional short product text — never chain-of-thought / SSE.
 */
export const toolChoiceDecisionSchema = z
  .object({
    action: z.enum(TOOL_CHOICE_ACTION_VALUES),
    toolName: z.enum(AGENT_TOOL_NAME_VALUES).optional(),
    toolArgs: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'call_tool' && !value.toolName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'toolName is required when action is call_tool',
        path: ['toolName'],
      });
    }
  });

/**
 * Builds the LangGraph thread id for one pending assistant message.
 * @param {string} orgId Tenant id.
 * @param {string} conversationId Conversation id.
 * @param {string} assistantMessageId Pending assistant message id.
 * @returns {string}
 */
export function buildChatGraphThreadId(orgId, conversationId, assistantMessageId) {
  return `${String(orgId)}:${String(conversationId)}:${String(assistantMessageId)}`;
}

/**
 * Parses thread id into scope parts. Fails closed on malformed keys.
 * @param {string} threadId Composite thread id.
 * @returns {{ orgId: string, conversationId: string, assistantMessageId: string }}
 * @throws {Error} When the key is not three colon-separated segments.
 */
export function parseChatGraphThreadId(threadId) {
  const parts = String(threadId ?? '').split(':');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new Error('invalid chat graph threadId');
  }
  return { orgId: parts[0], conversationId: parts[1], assistantMessageId: parts[2] };
}

/**
 * Creates a Mongo BaseCheckpointSaver scoped by orgId + threadId.
 * @param {{ ChatCheckpointModel?: typeof ChatCheckpoint }} [options] Test seam for the model only.
 * @returns {MongoChatCheckpointer}
 */
export function createMongoChatCheckpointer(options = {}) {
  return new MongoChatCheckpointer(options.ChatCheckpointModel ?? ChatCheckpoint);
}

/**
 * Tenant-aware LangGraph checkpointer backed by `chatCheckpoints`.
 */
class MongoChatCheckpointer extends BaseCheckpointSaver {
  /**
   * @param {typeof ChatCheckpoint} ChatCheckpointModel Mongoose model.
   */
  constructor(ChatCheckpointModel) {
    super();
    this.ChatCheckpointModel = ChatCheckpointModel;
  }

  /**
   * Loads one checkpoint tuple for the configured thread.
   * @param {object} config Runnable config with configurable.thread_id.
   * @returns {Promise<object | undefined>}
   */
  async getTuple(config) {
    const threadId = config?.configurable?.thread_id;
    if (threadId === undefined) {
      return undefined;
    }
    const scope = resolveCheckpointScope(config, threadId);
    if (!scope) {
      return undefined;
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const requestedId = config.configurable?.checkpoint_id;
    /** @type {object} */
    const filter = {
      orgId: scope.orgObjectId,
      threadId,
      checkpointNs,
      status: ROW_STATUS_ACTIVE,
    };
    let row;
    if (requestedId) {
      row = await this.ChatCheckpointModel.findOne({ ...filter, checkpointId: requestedId }).lean();
    } else {
      row = await this.ChatCheckpointModel.findOne(filter).sort({ createdAt: -1 }).lean();
    }
    if (!row) {
      return undefined;
    }
    return hydrateCheckpointTuple(row, this.serde);
  }

  /**
   * Lists checkpoints for a thread, newest first.
   * @param {object} config Runnable config.
   * @param {{ limit?: number, before?: object }} [options] List options.
   * @returns {AsyncGenerator<object>}
   */
  async *list(config, options = {}) {
    const threadId = config?.configurable?.thread_id;
    if (threadId === undefined) {
      return;
    }
    const scope = resolveCheckpointScope(config, threadId);
    if (!scope) {
      return;
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    /** @type {object} */
    const filter = {
      orgId: scope.orgObjectId,
      threadId,
      checkpointNs,
      status: ROW_STATUS_ACTIVE,
    };
    if (options.before?.configurable?.checkpoint_id) {
      const beforeRow = await this.ChatCheckpointModel.findOne({
        ...filter,
        checkpointId: options.before.configurable.checkpoint_id,
      }).lean();
      if (beforeRow?.createdAt) {
        filter.createdAt = { $lt: beforeRow.createdAt };
      }
    }
    let query = this.ChatCheckpointModel.find(filter).sort({ createdAt: -1 });
    if (Number.isFinite(options.limit) && options.limit > 0) {
      query = query.limit(options.limit);
    }
    const rows = await query.lean();
    for (const row of rows) {
      yield hydrateCheckpointTuple(row, this.serde);
    }
  }

  /**
   * Upserts a checkpoint row for the thread.
   * @param {object} config Runnable config.
   * @param {object} checkpoint LangGraph checkpoint.
   * @param {object} metadata LangGraph metadata.
   * @returns {Promise<object>} Config pointing at the stored checkpoint id.
   */
  async put(config, checkpoint, metadata) {
    const threadId = config?.configurable?.thread_id;
    if (threadId === undefined) {
      throw new Error('Failed to put checkpoint: missing thread_id');
    }
    const scope = resolveCheckpointScope(config, threadId);
    if (!scope) {
      throw new Error('Failed to put checkpoint: org scope mismatch');
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const parentCheckpointId = config.configurable?.checkpoint_id ?? null;
    const [checkpointType, checkpointBytes] = await this.serde.dumpsTyped(checkpoint);
    const [metadataType, metadataBytes] = await this.serde.dumpsTyped(metadata);
    const packedCheckpoint = {
      type: checkpointType,
      data: Buffer.from(checkpointBytes).toString('base64'),
    };
    const packedMetadata = {
      langGraph: {
        type: metadataType,
        data: Buffer.from(metadataBytes).toString('base64'),
      },
      product: {
        conversationId: scope.conversationId,
        assistantMessageId: scope.assistantMessageId,
      },
    };
    await this.ChatCheckpointModel.findOneAndUpdate(
      {
        orgId: scope.orgObjectId,
        threadId,
        checkpointNs,
        checkpointId: checkpoint.id,
        status: ROW_STATUS_ACTIVE,
      },
      {
        $set: {
          parentCheckpointId,
          checkpoint: packedCheckpoint,
          metadata: packedMetadata,
          updatedBy: null,
        },
        $setOnInsert: {
          orgId: scope.orgObjectId,
          threadId,
          checkpointNs,
          checkpointId: checkpoint.id,
          status: ROW_STATUS_ACTIVE,
          createdBy: null,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
        org_id: scope.orgId,
      },
    };
  }

  /**
   * Appends pending writes onto the checkpoint's metadata blob.
   * @param {object} config Runnable config with checkpoint_id.
   * @param {Array<[string, unknown]>} writes Channel writes.
   * @param {string} taskId Task id.
   * @param {string} [taskPath] Optional task path for ordering.
   * @returns {Promise<void>}
   */
  async putWrites(config, writes, taskId, taskPath = '') {
    const threadId = config?.configurable?.thread_id;
    const checkpointId = config?.configurable?.checkpoint_id;
    if (threadId === undefined || checkpointId === undefined) {
      throw new Error('Failed to put writes: missing thread_id or checkpoint_id');
    }
    const scope = resolveCheckpointScope(config, threadId);
    if (!scope) {
      throw new Error('Failed to put writes: org scope mismatch');
    }
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const row = await this.ChatCheckpointModel.findOne({
      orgId: scope.orgObjectId,
      threadId,
      checkpointNs,
      checkpointId,
      status: ROW_STATUS_ACTIVE,
    });
    if (!row) {
      return;
    }
    const metadata = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {};
    const pendingWrites = Array.isArray(metadata.pendingWrites) ? [...metadata.pendingWrites] : [];
    let idx = pendingWrites.length;
    for (const [channel, value] of writes) {
      const [valueType, valueBytes] = await this.serde.dumpsTyped(value);
      pendingWrites.push({
        taskId,
        taskPath,
        idx,
        channel,
        type: valueType,
        data: Buffer.from(valueBytes).toString('base64'),
      });
      idx += 1;
    }
    metadata.pendingWrites = pendingWrites;
    row.metadata = metadata;
    row.updatedBy = null;
    await row.save();
  }

  /**
   * Soft-deletes every active checkpoint for a thread in the parsed org.
   * @param {string} threadId Thread id.
   * @returns {Promise<void>}
   */
  async deleteThread(threadId) {
    const scope = parseChatGraphThreadId(threadId);
    if (!mongoose.isValidObjectId(scope.orgId)) {
      return;
    }
    await this.ChatCheckpointModel.updateMany(
      {
        orgId: new mongoose.Types.ObjectId(scope.orgId),
        threadId,
        status: ROW_STATUS_ACTIVE,
      },
      { $set: { status: ROW_STATUS_DELETED, updatedBy: null } },
    );
  }
}

/**
 * Resolves org scope from thread id and optional configurable.org_id.
 * Returns null when org_id is present and does not match (fail closed).
 * @param {object} config Runnable config.
 * @param {string} threadId Thread id.
 * @returns {{ orgId: string, orgObjectId: import('mongoose').Types.ObjectId, conversationId: string, assistantMessageId: string } | null}
 */
function resolveCheckpointScope(config, threadId) {
  let parsed;
  try {
    parsed = parseChatGraphThreadId(threadId);
  } catch {
    return null;
  }
  if (!mongoose.isValidObjectId(parsed.orgId)) {
    return null;
  }
  const claimedOrgId = config?.configurable?.org_id;
  if (claimedOrgId !== undefined && String(claimedOrgId) !== parsed.orgId) {
    return null;
  }
  return {
    orgId: parsed.orgId,
    orgObjectId: new mongoose.Types.ObjectId(parsed.orgId),
    conversationId: parsed.conversationId,
    assistantMessageId: parsed.assistantMessageId,
  };
}

/**
 * Hydrates a Mongo row into a LangGraph CheckpointTuple.
 * @param {object} row Lean checkpoint document.
 * @param {object} serde Saver serializer.
 * @returns {Promise<object>}
 */
async function hydrateCheckpointTuple(row, serde) {
  const packed = row.checkpoint ?? {};
  const checkpoint = await serde.loadsTyped(packed.type ?? 'json', Buffer.from(String(packed.data ?? ''), 'base64'));
  const lgMeta = row.metadata?.langGraph;
  const metadata = lgMeta ? await serde.loadsTyped(lgMeta.type ?? 'json', Buffer.from(String(lgMeta.data ?? ''), 'base64')) : undefined;
  /** @type {Array<[string, string, unknown]> | undefined} */
  let pendingWrites;
  if (Array.isArray(row.metadata?.pendingWrites)) {
    pendingWrites = [];
    for (const write of row.metadata.pendingWrites) {
      const value = await serde.loadsTyped(write.type ?? 'json', Buffer.from(String(write.data ?? ''), 'base64'));
      pendingWrites.push([write.taskId, write.channel, value]);
    }
  }
  /** @type {object} */
  const tuple = {
    config: {
      configurable: {
        thread_id: row.threadId,
        checkpoint_ns: row.checkpointNs ?? '',
        checkpoint_id: row.checkpointId,
        org_id: String(row.orgId),
      },
    },
    checkpoint,
    metadata,
    pendingWrites,
  };
  if (row.parentCheckpointId) {
    tuple.parentConfig = {
      configurable: {
        thread_id: row.threadId,
        checkpoint_ns: row.checkpointNs ?? '',
        checkpoint_id: row.parentCheckpointId,
        org_id: String(row.orgId),
      },
    };
  }
  return tuple;
}
