/**
 * Unit tests for chat SSE helpers and runChatMessageStream orchestration.
 */
import { ApiError } from '../../../src/platform/errors.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatSseEvent, runChatMessageStream, acceptIncludesEventStream } from '../../../src/modules/conversation/chatStream.js';

const mocks = vi.hoisted(() => ({
  loadConversationForUser: vi.fn(),
  assertConversationWritable: vi.fn(),
  assertKnowledgeReadable: vi.fn(),
  findProjectById: vi.fn(),
  insertChatTurnPair: vi.fn(),
  finalizeAssistantMessage: vi.fn(),
  invokeChatGraph: vi.fn(),
  buildChatGraphThreadId: vi.fn(),
  createMongoChatCheckpointer: vi.fn(),
  persistOpenClarificationSetFromInterrupt: vi.fn(),
  supersedeOpenClarificationSetsForMessages: vi.fn(),
}));

vi.mock('../../../src/modules/conversation/conversation.js', () => ({
  loadConversationForUser: mocks.loadConversationForUser,
  assertConversationWritable: mocks.assertConversationWritable,
  refreshConversationSearchText: vi.fn(),
}));

vi.mock('../../../src/modules/knowledge/index.js', () => ({
  assertKnowledgeReadable: mocks.assertKnowledgeReadable,
}));

vi.mock('../../../src/modules/masters/index.js', () => ({
  findProjectById: mocks.findProjectById,
}));

vi.mock('../../../src/modules/conversation/conversation.helper.js', () => ({
  insertChatTurnPair: mocks.insertChatTurnPair,
  finalizeAssistantMessage: mocks.finalizeAssistantMessage,
}));

vi.mock('../../../src/modules/conversation/chatGraph.js', () => ({
  invokeChatGraph: mocks.invokeChatGraph,
  buildChatGraphThreadId: mocks.buildChatGraphThreadId,
  createMongoChatCheckpointer: mocks.createMongoChatCheckpointer,
}));

vi.mock('../../../src/modules/conversation/clarification.js', () => ({
  persistOpenClarificationSetFromInterrupt: mocks.persistOpenClarificationSetFromInterrupt,
  supersedeOpenClarificationSetsForMessages: mocks.supersedeOpenClarificationSetsForMessages,
}));

describe('chatStream helpers', () => {
  it('acceptIncludesEventStream requires text/event-stream', () => {
    expect(acceptIncludesEventStream(undefined)).toBe(false);
    expect(acceptIncludesEventStream('application/json')).toBe(false);
    expect(acceptIncludesEventStream('text/event-stream')).toBe(true);
    expect(acceptIncludesEventStream('text/event-stream, application/json')).toBe(true);
  });

  it('formatSseEvent writes event and data lines without CoT fields', () => {
    const block = formatSseEvent('status', { stage: 'accepted' });
    expect(block).toBe('event: status\ndata: {"stage":"accepted"}\n\n');
    expect(block).not.toMatch(/thinking|reasoning/i);
  });
});

describe('runChatMessageStream', () => {
  const baseInput = {
    orgId: '507f1f77bcf86cd799439011',
    projectId: '507f1f77bcf86cd799439012',
    conversationId: '507f1f77bcf86cd799439013',
    actorUserId: '507f1f77bcf86cd799439014',
    content: 'How does login work?',
    correlationId: 'REQ-test',
    workspaceRoot: '/tmp/ws',
    isClientConnected: () => true,
    openSse: vi.fn(),
    writeSse: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConversationForUser.mockResolvedValue({
      ownerUserId: baseInput.actorUserId,
      lifecycleStatus: 'active',
    });
    mocks.assertConversationWritable.mockImplementation(() => {});
    mocks.findProjectById.mockResolvedValue({ knowledgeHealth: 'ready' });
    mocks.insertChatTurnPair.mockResolvedValue({
      userMessage: { _id: '507f1f77bcf86cd799439021' },
      assistantMessage: { _id: '507f1f77bcf86cd799439022' },
    });
    mocks.buildChatGraphThreadId.mockReturnValue('thread-1');
    mocks.createMongoChatCheckpointer.mockReturnValue({});
    mocks.finalizeAssistantMessage.mockResolvedValue({ messageStatus: 'awaiting_clarification' });
    mocks.persistOpenClarificationSetFromInterrupt.mockResolvedValue({});
    mocks.supersedeOpenClarificationSetsForMessages.mockResolvedValue(undefined);
  });

  it('throws KNOWLEDGE_UNAVAILABLE without inserting when gate denies', async () => {
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'deny', code: 'KNOWLEDGE_UNAVAILABLE' });
    await expect(runChatMessageStream(baseInput)).rejects.toMatchObject({ code: 'KNOWLEDGE_UNAVAILABLE' });
    expect(mocks.insertChatTurnPair).not.toHaveBeenCalled();
    expect(mocks.invokeChatGraph).not.toHaveBeenCalled();
  });

  it('throws KNOWLEDGE_UPDATING without SSE when gate queues', async () => {
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'queue', code: 'KNOWLEDGE_UPDATING' });
    await expect(runChatMessageStream(baseInput)).rejects.toMatchObject({ code: 'KNOWLEDGE_UPDATING' });
    expect(mocks.insertChatTurnPair).not.toHaveBeenCalled();
  });

  it('emits accepted status and done when graph completes', async () => {
    mocks.assertKnowledgeReadable.mockResolvedValue({
      action: 'allow',
      knowledgeVersionId: '507f1f77bcf86cd799439099',
    });
    mocks.invokeChatGraph.mockImplementation(async (args) => {
      args.onStage({ stage: 'understanding_question' });
      args.onDelta('Hello');
      args.onEvidence([{ evidenceId: 'ev_01' }]);
      args.onDone({ messageId: '507f1f77bcf86cd799439022' });
      return { answerContent: 'Hello' };
    });

    const result = await runChatMessageStream(baseInput);
    expect(baseInput.openSse).toHaveBeenCalled();
    expect(baseInput.writeSse).toHaveBeenCalledWith('status', { stage: 'accepted', knowledgeHealth: 'ready' });
    expect(baseInput.writeSse).toHaveBeenCalledWith('status', { stage: 'understanding_question' });
    expect(baseInput.writeSse).toHaveBeenCalledWith('delta', { text: 'Hello' });
    expect(baseInput.writeSse).toHaveBeenCalledWith('evidence', { items: [{ evidenceId: 'ev_01' }] });
    expect(baseInput.writeSse).toHaveBeenCalledWith('done', { messageId: '507f1f77bcf86cd799439022' });
    expect(result.messageStatus).toBe('completed');
  });

  it('stops writes after disconnect but still invokes the graph', async () => {
    let connected = true;
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId: '507f1f77bcf86cd799439099' });
    mocks.invokeChatGraph.mockImplementation(async (args) => {
      connected = false;
      args.onDelta('secret');
      args.onDone({ messageId: '507f1f77bcf86cd799439022' });
      return {};
    });

    const writeSse = vi.fn();
    await runChatMessageStream({
      ...baseInput,
      isClientConnected: () => connected,
      writeSse,
    });
    expect(mocks.invokeChatGraph).toHaveBeenCalled();
    expect(writeSse).toHaveBeenCalledWith('status', expect.objectContaining({ stage: 'accepted' }));
    expect(writeSse).not.toHaveBeenCalledWith('delta', expect.anything());
    expect(writeSse).not.toHaveBeenCalledWith('done', expect.anything());
  });

  it('emits clarification and marks awaiting_clarification on interrupt', async () => {
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId: '507f1f77bcf86cd799439099' });
    mocks.invokeChatGraph.mockResolvedValue({
      __interrupt__: [
        {
          value: {
            clarificationSetId: 'clr_1',
            questions: [{ id: 'q1', type: 'free_text', prompt: 'Which env?' }],
          },
        },
      ],
    });

    const result = await runChatMessageStream(baseInput);
    expect(result.messageStatus).toBe('awaiting_clarification');
    expect(mocks.finalizeAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ messageStatus: 'awaiting_clarification' }));
    expect(mocks.persistOpenClarificationSetFromInterrupt).toHaveBeenCalled();
    expect(baseInput.writeSse).toHaveBeenCalledWith('clarification', {
      clarificationSetId: 'clr_1',
      roundIndex: 0,
      questions: [{ id: 'q1', type: 'free_text', prompt: 'Which env?' }],
    });
  });

  it('marks assistant failed and rethrows when the graph throws', async () => {
    mocks.assertKnowledgeReadable.mockResolvedValue({ action: 'allow', knowledgeVersionId: '507f1f77bcf86cd799439099' });
    mocks.invokeChatGraph.mockRejectedValue(ApiError.fromCode('LLM_PROVIDER_ERROR'));
    await expect(runChatMessageStream(baseInput)).rejects.toMatchObject({ code: 'LLM_PROVIDER_ERROR' });
    expect(mocks.finalizeAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ messageStatus: 'failed' }));
  });
});
