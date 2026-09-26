/**
 * `messages` — one turn in a chat thread: Alice's question or the
 * assistant's answer. Assistant rows store `evidence` so the UI can
 * show which source files the answer came from.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

export const MESSAGE_ROLE_VALUES = Object.freeze(['user', 'assistant', 'system']);
export const MESSAGE_STATUS_VALUES = Object.freeze(['completed']);

const messageSchema = createBaseSchema({
  // Project the parent thread belongs to
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // Chat thread this turn belongs to
  conversationId: { type: ObjectId, ref: 'Conversation', required: true },
  // Who wrote it: user (Alice), assistant (the answer), or system
  role: { type: String, enum: MESSAGE_ROLE_VALUES, required: true },
  // Visible text of the question or answer
  content: { type: String, required: true, default: '' },
  // Whether this turn is finished (currently always completed)
  messageStatus: { type: String, enum: MESSAGE_STATUS_VALUES, required: true, default: 'completed' },
  // Knowledge snapshot the assistant used to answer
  knowledgeVersionId: { type: ObjectId, ref: 'KnowledgeVersion', default: null },
  // Earlier message this turn replies to, when the thread is branched
  parentMessageId: { type: ObjectId, ref: 'Message', default: null },
  // Source citations for an assistant answer (file, lines) — what the UI inspects
  evidence: { type: mongoose.Schema.Types.Mixed, default: null },
  // Token / model-usage numbers for this turn
  usage: { type: mongoose.Schema.Types.Mixed, default: null },
  // How much context was retrieved; used to debug grounding, not shown to Alice
  contextMetrics: { type: mongoose.Schema.Types.Mixed, default: null },
});

messageSchema.index({ orgId: 1, conversationId: 1, createdAt: 1, _id: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
messageSchema.index({ orgId: 1, projectId: 1, conversationId: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });

export const Message = mongoose.models.Message ?? mongoose.model('Message', messageSchema, 'messages');
