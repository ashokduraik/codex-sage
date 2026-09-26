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
/** How a pinned fact was captured — clarification answers or a later user correction. */
export const PINNED_FACT_SOURCE_VALUES = Object.freeze(['clarification', 'user_correction']);

const pinnedFactSchema = new mongoose.Schema(
  {
    // Caller-supplied pin id (clarification answer id, or a generated key)
    id: { type: String, required: true, trim: true },
    // Fact text Alice confirmed, e.g. "login uses session cookies"
    text: { type: String, required: true, trim: true },
    // Where the pin came from so later phases can audit the source
    source: { type: String, enum: PINNED_FACT_SOURCE_VALUES, required: true },
    // Message that produced this pin, when known
    messageId: { type: ObjectId, ref: 'Message', default: null },
    // When the pin was stored
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const conversationContextSchema = new mongoose.Schema(
  {
    // Extractive rolling summary of older user questions (not an LLM rewrite)
    summaryText: { type: String, default: '' },
    // Last time the extractive summary was refreshed; null until the first write
    summaryUpdatedAt: { type: Date, default: null },
    // Last message id covered by summaryText
    summaryCoversThroughMessageId: { type: ObjectId, ref: 'Message', default: null },
    // Protected facts always sent to the budgeter as pinned_fact segments
    pinnedFacts: { type: [pinnedFactSchema], default: () => [] },
  },
  { _id: false },
);

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
  // Rolling summary and pinned facts for the context budgeter (Phase 44)
  context: { type: conversationContextSchema, default: () => ({}) },
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
