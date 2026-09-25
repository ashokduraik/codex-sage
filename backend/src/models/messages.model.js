/**
 * `messages` — one row per turn in a conversation (user, assistant, or system).
 * Assistant turns keep inspectable evidence used to ground the answer.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';
export const MESSAGE_ROLE_VALUES = Object.freeze(['user', 'assistant', 'system']);
export const MESSAGE_STATUS_VALUES = Object.freeze(['completed']);

const messageSchema = createBaseSchema({
  // Project the parent conversation belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Thread this turn belongs to
  conversationId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Who spoke: user, assistant, or system
  role: { type: String, enum: MESSAGE_ROLE_VALUES, required: true },
  // Visible message text
  content: { type: String, required: true, default: '' },
  // Persistence state of this turn (currently completed only)
  messageStatus: { type: String, enum: MESSAGE_STATUS_VALUES, required: true, default: 'completed' },
  // Knowledge snapshot the assistant used to answer
  knowledgeVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Prior message this turn replies to, when the thread is branched
  parentMessageId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Inspectable citations that ground an assistant answer
  evidence: { type: mongoose.Schema.Types.Mixed, default: null },
  // Token or model-usage stats for this turn
  usage: { type: mongoose.Schema.Types.Mixed, default: null },
  // Retrieval/context size stats for debugging grounding
  contextMetrics: { type: mongoose.Schema.Types.Mixed, default: null },
});

messageSchema.index(
  { orgId: 1, conversationId: 1, createdAt: 1, _id: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
messageSchema.index(
  { orgId: 1, projectId: 1, conversationId: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const Message =
  mongoose.models.Message ?? mongoose.model('Message', messageSchema, 'messages');
