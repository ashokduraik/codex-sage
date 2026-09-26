/**
 * `conversations` — one chat thread Alice opened in a project.
 * Only she sees it. The title and message count live here; the actual
 * questions and answers live in `messages`.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

export const CONVERSATION_TITLE_MAX_LENGTH = 200;
export const CONVERSATION_LIFECYCLE_STATUS_VALUES = Object.freeze(['active', 'archived']);
export const CONVERSATION_TITLE_SOURCE_VALUES = Object.freeze(['default', 'user', 'truncated_user_text', 'llm']);

const conversationSchema = createBaseSchema({
  // Project this thread belongs to (Payments API)
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // User who owns this thread (only Alice can see it)
  ownerUserId: { type: ObjectId, ref: 'User', required: true },
  // Sidebar title, e.g. "How does login work?"
  title: { type: String, required: true, trim: true, minlength: 1, maxlength: CONVERSATION_TITLE_MAX_LENGTH },
  // Who set the title: default, Alice, first-message text, or the model
  titleSource: { type: String, enum: CONVERSATION_TITLE_SOURCE_VALUES, required: true, default: 'default' },
  // Extra words used when searching conversations
  searchText: { type: String, default: '' },
  // active = in the open list; archived = hidden until restored
  lifecycleStatus: { type: String, enum: CONVERSATION_LIFECYCLE_STATUS_VALUES, required: true, default: 'active' },
  // When Alice archived this thread; null if it is still open
  archivedAt: { type: Date, default: null },
  // Time of the latest message (sorts the sidebar)
  lastMessageAt: { type: Date, default: null },
  // Cached number of turns in the thread
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

export const Conversation = mongoose.models.Conversation ?? mongoose.model('Conversation', conversationSchema, 'conversations');
