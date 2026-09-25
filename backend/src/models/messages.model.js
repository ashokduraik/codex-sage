/**
 * Message Mongoose model — one row per turn in a conversation.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';
export const MESSAGE_ROLE_VALUES = Object.freeze(['user', 'assistant', 'system']);
export const MESSAGE_STATUS_VALUES = Object.freeze(['completed']);

const messageSchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  role: {
    type: String,
    enum: MESSAGE_ROLE_VALUES,
    required: true,
  },
  content: {
    type: String,
    required: true,
    default: '',
  },
  messageStatus: {
    type: String,
    enum: MESSAGE_STATUS_VALUES,
    required: true,
    default: 'completed',
  },
  knowledgeVersionId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  parentMessageId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  evidence: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  usage: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  contextMetrics: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
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
