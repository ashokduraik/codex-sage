/**
 * `chatCheckpoints` — durable LangGraph snapshots for one chat answer run so
 * clarification pause and client disconnect can resume the same thread.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const chatCheckpointSchema = createBaseSchema({
  // LangGraph thread key: `{orgId}:{conversationId}:{assistantMessageId}`
  threadId: { type: String, required: true, trim: true },
  // LangGraph checkpoint namespace; empty string unless a second graph shares the thread
  // (not `required: true` — Mongoose treats '' as missing when required)
  checkpointNs: { type: String, default: '', trim: true },
  // Snapshot id within the thread (library-generated)
  checkpointId: { type: String, required: true, trim: true },
  // Previous snapshot id for the resume history chain; null at the root
  parentCheckpointId: { type: String, default: null },
  // Serialized graph channels at this step (no private model reasoning)
  checkpoint: { type: mongoose.Schema.Types.Mixed, required: true },
  // Small ops hints plus LangGraph metadata / pending writes (not full channel state)
  metadata: { type: mongoose.Schema.Types.Mixed, default: null },
});

chatCheckpointSchema.index({ orgId: 1, threadId: 1, checkpointId: 1 }, { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
chatCheckpointSchema.index({ orgId: 1, threadId: 1, createdAt: -1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });

export const ChatCheckpoint = mongoose.models.ChatCheckpoint ?? mongoose.model('ChatCheckpoint', chatCheckpointSchema, 'chatCheckpoints');
