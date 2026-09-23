/**
 * Conversation Mongoose model — owner-private chat thread header.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import {
  CONVERSATION_LIFECYCLE_STATUS_VALUES,
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATION_TITLE_SOURCE_VALUES,
} from './conversations.constants.js';

const conversationSchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  ownerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: CONVERSATION_TITLE_MAX_LENGTH,
  },
  titleSource: {
    type: String,
    enum: CONVERSATION_TITLE_SOURCE_VALUES,
    required: true,
    default: 'default',
  },
  searchText: {
    type: String,
    default: '',
  },
  lifecycleStatus: {
    type: String,
    enum: CONVERSATION_LIFECYCLE_STATUS_VALUES,
    required: true,
    default: 'active',
  },
  archivedAt: {
    type: Date,
    default: null,
  },
  lastMessageAt: {
    type: Date,
    default: null,
  },
  messageCount: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },
});

conversationSchema.index(
  { orgId: 1, projectId: 1, ownerUserId: 1, updatedAt: -1, _id: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
conversationSchema.index(
  { orgId: 1, projectId: 1, ownerUserId: 1, lifecycleStatus: 1, updatedAt: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
conversationSchema.index(
  { title: 'text', searchText: 'text' },
  {
    weights: { title: 10, searchText: 5 },
    name: 'conversation_search_text',
  },
);

export const Conversation =
  mongoose.models.Conversation ??
  mongoose.model('Conversation', conversationSchema, 'conversations');
