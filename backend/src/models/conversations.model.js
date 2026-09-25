/**
 * `conversations` — owner-private chat thread headers inside a project.
 * Stores title, archive state, and cached message counts; turns live in messages.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';
export const CONVERSATION_TITLE_MAX_LENGTH = 200;
export const CONVERSATION_LIFECYCLE_STATUS_VALUES = Object.freeze(['active', 'archived']);
export const CONVERSATION_TITLE_SOURCE_VALUES = Object.freeze([
  'default',
  'user',
  'truncated_user_text',
  'llm',
]);

const conversationSchema = createBaseSchema({
  // Project this chat thread belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // User who owns this private thread
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // List title shown in the conversation sidebar
  title: { type: String, required: true, trim: true, minlength: 1, maxlength: CONVERSATION_TITLE_MAX_LENGTH },
  // How the title was produced (default, user, truncated text, or LLM)
  titleSource: { type: String, enum: CONVERSATION_TITLE_SOURCE_VALUES, required: true, default: 'default' },
  // Extra text indexed for conversation search
  searchText: { type: String, default: '' },
  // Whether the thread is open or archived
  lifecycleStatus: { type: String, enum: CONVERSATION_LIFECYCLE_STATUS_VALUES, required: true, default: 'active' },
  // When the owner archived this thread
  archivedAt: { type: Date, default: null },
  // Timestamp of the latest message, for sorting
  lastMessageAt: { type: Date, default: null },
  // Cached number of messages in the thread
  messageCount: { type: Number, required: true, default: 0, min: 0 },
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
