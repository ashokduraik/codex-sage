/**
 * Unit tests for queued chat drain, fail, and expiry helpers.
 */
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWriterJobId,
  QUEUED_MESSAGE_TTL_MS,
  isKnowledgeWriterJobType,
  notifyKnowledgePublished,
  sweepExpiredQueuedMessages,
  failQueuedMessagesForProject,
  enqueueChatMessageWhileKnowledgeUpdating,
} from '../../../src/modules/conversation/chatQueue.js';

const mocks = vi.hoisted(() => ({
  findActiveProjectWriterLockJobId: vi.fn(),
  findActiveJobForProjectByTypes: vi.fn(),
  assertKnowledgeReadable: vi.fn(),
  insertQueuedUserMessage: vi.fn(),
  listUnexpiredQueuedMessages: vi.fn(),
  claimQueuedMessageForResume: vi.fn(),
  insertAssistantForQueuedUser: vi.fn(),
  markQueuedMessagesFailed: vi.fn(),
  markExpiredQueuedMessagesFailed: vi.fn(),
  finalizeAssistantMessage: vi.fn(),
  invokeChatGraph: vi.fn(),
  buildChatGraphThreadId: vi.fn(),
  createMongoChatCheckpointer: vi.fn(),
  loadConfig: vi.fn(),
  MessageFindOneAndUpdate: vi.fn(),
}));

vi.mock('../../../src/worker/projectLock.js', () => ({
  findActiveProjectWriterLockJobId: mocks.findActiveProjectWriterLockJobId,
}));

vi.mock('../../../src/modules/masters/index.js', () => ({
  findActiveJobForProjectByTypes: mocks.findActiveJobForProjectByTypes,
}));

vi.mock('../../../src/modules/knowledge/index.js', () => ({
  assertKnowledgeReadable: mocks.assertKnowledgeReadable,
}));

vi.mock('../../../src/platform/config.js', () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock('../../../src/models/messages.model.js', () => ({
  Message: {
    findOneAndUpdate: (...args) => mocks.MessageFindOneAndUpdate(...args),
  },
}));

vi.mock('../../../src/modules/conversation/conversation.helper.js', () => ({
  insertQueuedUserMessage: mocks.insertQueuedUserMessage,
  listUnexpiredQueuedMessages: mocks.listUnexpiredQueuedMessages,
  claimQueuedMessageForResume: mocks.claimQueuedMessageForResume,
  insertAssistantForQueuedUser: mocks.insertAssistantForQueuedUser,
  markQueuedMessagesFailed: mocks.markQueuedMessagesFailed,
  markExpiredQueuedMessagesFailed: mocks.markExpiredQueuedMessagesFailed,
  finalizeAssistantMessage: mocks.finalizeAssistantMessage,
}));

vi.mock('../../../src/modules/conversation/chatGraph.js', () => ({
  invokeChatGraph: mocks.invokeChatGraph,
  buildChatGraphThreadId: mocks.buildChatGraphThreadId,
  createMongoChatCheckpointer: mocks.createMongoChatCheckpointer,
}));

describe('chatQueue helpers', () => {
  const orgId = new mongoose.Types.ObjectId().toString();
  const projectId = new mongoose.Types.ObjectId().toString();
  const conversationId = new mongoose.Types.ObjectId().toString();
  const actorUserId = new mongoose.Types.ObjectId().toString();
  const messageId = new mongoose.Types.ObjectId().toString();
  const knowledgeVersionId = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({ workspace: { root: '/tmp/ws' } });
    mocks.buildChatGraphThreadId.mockReturnValue('thread-q');
    mocks.createMongoChatCheckpointer.mockReturnValue({});
    mocks.MessageFindOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue({}) });
  });

  it('isKnowledgeWriterJobType recognizes ingest family only', () => {
    expect(isKnowledgeWriterJobType('project_knowledge_build')).toBe(true);
    expect(isKnowledgeWriterJobType('project_knowledge_rebuild')).toBe(true);
    expect(isKnowledgeWriterJobType('connected_repo_pull')).toBe(true);
    expect(isKnowledgeWriterJobType('aged_org_data_cleanup')).toBe(false);
  });

  it('resolveWriterJobId prefers lock jobId then active writer job', async () => {
    mocks.findActiveProjectWriterLockJobId.mockResolvedValueOnce('lock-job');
    await expect(resolveWriterJobId({ orgId, projectId })).resolves.toBe('lock-job');

    mocks.findActiveProjectWriterLockJobId.mockResolvedValueOnce(null);
    mocks.findActiveJobForProjectByTypes.mockResolvedValueOnce({ _id: 'active-job' });
    await expect(resolveWriterJobId({ orgId, projectId })).resolves.toBe('active-job');

    mocks.findActiveProjectWriterLockJobId.mockResolvedValueOnce(null);
    mocks.findActiveJobForProjectByTypes.mockResolvedValueOnce(null);
    await expect(resolveWriterJobId({ orgId, projectId })).resolves.toBeNull();
  });

  it('enqueueChatMessageWhileKnowledgeUpdating persists queued row and TTL', async () => {
    mocks.findActiveProjectWriterLockJobId.mockResolvedValue('job-1');
    mocks.insertQueuedUserMessage.mockResolvedValue({ _id: messageId });

    const body = await enqueueChatMessageWhileKnowledgeUpdating({
      orgId,
      projectId,
      conversationId,
      actorUserId,
      content: 'How does auth work?',
    });

    expect(body.messageId).toBe(messageId);
    expect(body.jobId).toBe('job-1');
    expect(body.messageStatus).toBe('queued');
    expect(mocks.insertQueuedUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'How does auth work?',
        blockingJobId: 'job-1',
      }),
    );
    const insertArgs = mocks.insertQueuedUserMessage.mock.calls[0][0];
    expect(insertArgs.expiresAt.getTime() - insertArgs.queuedAt.getTime()).toBe(QUEUED_MESSAGE_TTL_MS);
  });

  it('notifyKnowledgePublished resumes FIFO claimed messages when gate allows', async () => {
    const claimed = {
      _id: messageId,
      orgId,
      projectId,
      conversationId,
      content: 'queued question',
      createdBy: actorUserId,
    };
    mocks.listUnexpiredQueuedMessages.mockResolvedValue([{ _id: messageId }]);
    mocks.claimQueuedMessageForResume.mockResolvedValue(claimed);
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId });
    mocks.insertAssistantForQueuedUser.mockResolvedValue({ _id: new mongoose.Types.ObjectId().toString() });
    mocks.invokeChatGraph.mockImplementation(async (args) => {
      args.onDone?.({});
      return { answerContent: 'ok' };
    });

    const result = await notifyKnowledgePublished({ orgId, projectId, knowledgeVersionId });
    expect(result.resumed).toBe(1);
    expect(result.failed).toBe(0);
    expect(mocks.invokeChatGraph).toHaveBeenCalledTimes(1);
  });

  it('notifyKnowledgePublished fails claimed row when gate is not allow', async () => {
    const claimed = {
      _id: messageId,
      orgId,
      projectId,
      conversationId,
      content: 'queued question',
      createdBy: actorUserId,
    };
    mocks.listUnexpiredQueuedMessages.mockResolvedValue([{ _id: messageId }]);
    mocks.claimQueuedMessageForResume.mockResolvedValue(claimed);
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' });

    const result = await notifyKnowledgePublished({ orgId, projectId, knowledgeVersionId });
    expect(result.failed).toBe(1);
    expect(result.resumed).toBe(0);
    expect(mocks.invokeChatGraph).not.toHaveBeenCalled();
    expect(mocks.MessageFindOneAndUpdate).toHaveBeenCalled();
  });

  it('notifyKnowledgePublished skips when claim loses the race', async () => {
    mocks.listUnexpiredQueuedMessages.mockResolvedValue([{ _id: messageId }]);
    mocks.claimQueuedMessageForResume.mockResolvedValue(null);

    const result = await notifyKnowledgePublished({ orgId, projectId, knowledgeVersionId });
    expect(result.skipped).toBe(1);
    expect(mocks.invokeChatGraph).not.toHaveBeenCalled();
  });

  it('failQueuedMessagesForProject and sweepExpiredQueuedMessages delegate to helpers', async () => {
    mocks.markQueuedMessagesFailed.mockResolvedValue(3);
    mocks.markExpiredQueuedMessagesFailed.mockResolvedValue(2);

    await expect(failQueuedMessagesForProject({ orgId, projectId, reason: 'test' })).resolves.toBe(3);
    await expect(sweepExpiredQueuedMessages()).resolves.toBe(2);
  });

  it('notifyKnowledgePublished marks awaiting_clarification on graph interrupt', async () => {
    const claimed = {
      _id: messageId,
      orgId,
      projectId,
      conversationId,
      content: 'queued question',
      createdBy: actorUserId,
    };
    mocks.listUnexpiredQueuedMessages.mockResolvedValue([{ _id: messageId }]);
    mocks.claimQueuedMessageForResume.mockResolvedValue(claimed);
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId });
    mocks.insertAssistantForQueuedUser.mockResolvedValue({ _id: new mongoose.Types.ObjectId().toString() });
    mocks.invokeChatGraph.mockResolvedValue({
      __interrupt__: [{ value: { clarificationSetId: 'cs1', questions: [] } }],
    });

    const result = await notifyKnowledgePublished({ orgId, projectId, knowledgeVersionId });
    expect(result.resumed).toBe(1);
    expect(mocks.finalizeAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ messageStatus: 'awaiting_clarification' }));
  });

  it('notifyKnowledgePublished counts failed when graph throws after assistant insert', async () => {
    const claimed = {
      _id: messageId,
      orgId,
      projectId,
      conversationId,
      content: 'queued question',
      createdBy: actorUserId,
    };
    mocks.listUnexpiredQueuedMessages.mockResolvedValue([{ _id: messageId }]);
    mocks.claimQueuedMessageForResume.mockResolvedValue(claimed);
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId });
    mocks.insertAssistantForQueuedUser.mockResolvedValue({ _id: new mongoose.Types.ObjectId().toString() });
    mocks.invokeChatGraph.mockRejectedValue(new Error('graph boom'));
    mocks.finalizeAssistantMessage.mockResolvedValue({ messageStatus: 'failed' });

    const result = await notifyKnowledgePublished({
      orgId,
      projectId,
      knowledgeVersionId,
      log: { error: vi.fn() },
    });
    expect(result.failed).toBe(1);
    expect(mocks.finalizeAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ messageStatus: 'failed' }));
  });

  it('notifyKnowledgePublished finalizes completed when onDone was not fired', async () => {
    const claimed = {
      _id: messageId,
      orgId,
      projectId,
      conversationId,
      content: 'queued question',
      createdBy: actorUserId,
    };
    mocks.listUnexpiredQueuedMessages.mockResolvedValue([{ _id: messageId }]);
    mocks.claimQueuedMessageForResume.mockResolvedValue(claimed);
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId });
    mocks.insertAssistantForQueuedUser.mockResolvedValue({ _id: new mongoose.Types.ObjectId().toString() });
    mocks.invokeChatGraph.mockResolvedValue({ answerContent: 'done without hook', supportLevel: 'evidence_backed' });
    mocks.finalizeAssistantMessage.mockResolvedValue({ messageStatus: 'completed' });

    const result = await notifyKnowledgePublished({ orgId, projectId, knowledgeVersionId });
    expect(result.resumed).toBe(1);
    expect(mocks.finalizeAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageStatus: 'completed', content: 'done without hook' }),
    );
  });

  it('sweepExpiredQueuedMessages rethrows after logging', async () => {
    mocks.markExpiredQueuedMessagesFailed.mockRejectedValue(new Error('mongo down'));
    const log = { error: vi.fn() };
    await expect(sweepExpiredQueuedMessages({ log })).rejects.toThrow('mongo down');
    expect(log.error).toHaveBeenCalled();
  });

  it('failQueuedMessagesForProject logs when a logger is provided', async () => {
    mocks.markQueuedMessagesFailed.mockResolvedValue(1);
    const log = { info: vi.fn() };
    await failQueuedMessagesForProject({ orgId, projectId, reason: 'writer_job_cancelled', log });
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ modified: 1 }), expect.any(String));
  });

  it('notifyKnowledgePublished logs when failClaimedUserMessage update throws', async () => {
    const claimed = {
      _id: messageId,
      orgId,
      projectId,
      conversationId,
      content: 'queued question',
      createdBy: actorUserId,
    };
    mocks.listUnexpiredQueuedMessages.mockResolvedValue([{ _id: messageId }]);
    mocks.claimQueuedMessageForResume.mockResolvedValue(claimed);
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'queue', code: 'KNOWLEDGE_UPDATING' });
    mocks.MessageFindOneAndUpdate.mockReturnValue({
      exec: vi.fn().mockRejectedValue(new Error('write failed')),
    });
    const log = { error: vi.fn() };
    const result = await notifyKnowledgePublished({ orgId, projectId, knowledgeVersionId, log });
    expect(result.failed).toBe(1);
    expect(log.error).toHaveBeenCalled();
  });

  it('notifyKnowledgePublished handles onError hook and persist failure after throw', async () => {
    const claimed = {
      _id: messageId,
      orgId,
      projectId,
      conversationId,
      content: 'queued question',
      createdBy: actorUserId,
    };
    mocks.listUnexpiredQueuedMessages.mockResolvedValue([{ _id: messageId }]);
    mocks.claimQueuedMessageForResume.mockResolvedValue(claimed);
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId });
    mocks.insertAssistantForQueuedUser.mockResolvedValue({ _id: new mongoose.Types.ObjectId().toString() });
    mocks.invokeChatGraph.mockImplementation(async (args) => {
      args.onError?.(new Error('stream error'));
      throw new Error('graph boom');
    });
    mocks.finalizeAssistantMessage.mockRejectedValue(new Error('persist boom'));
    const log = { error: vi.fn() };
    const result = await notifyKnowledgePublished({ orgId, projectId, knowledgeVersionId, log });
    expect(result.failed).toBe(1);
    expect(log.error).toHaveBeenCalled();
  });

  it('notifyKnowledgePublished abstains when supportLevel is insufficient', async () => {
    const claimed = {
      _id: messageId,
      orgId,
      projectId,
      conversationId,
      content: 'queued question',
      createdBy: actorUserId,
    };
    mocks.listUnexpiredQueuedMessages.mockResolvedValue([{ _id: messageId }]);
    mocks.claimQueuedMessageForResume.mockResolvedValue(claimed);
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId });
    mocks.insertAssistantForQueuedUser.mockResolvedValue({ _id: new mongoose.Types.ObjectId().toString() });
    mocks.invokeChatGraph.mockResolvedValue({ answerContent: '', supportLevel: 'insufficient' });
    mocks.finalizeAssistantMessage.mockResolvedValue({ messageStatus: 'abstained' });

    const result = await notifyKnowledgePublished({ orgId, projectId, knowledgeVersionId });
    expect(result.resumed).toBe(1);
    expect(mocks.finalizeAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ messageStatus: 'abstained' }));
  });
});
