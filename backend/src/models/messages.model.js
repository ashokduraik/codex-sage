/**
 * `messages` — one turn in a chat thread: Alice's question or the
 * assistant's answer. Assistant rows store `evidence` so the UI can
 * show which source files the answer came from.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

export const MESSAGE_ROLE_VALUES = Object.freeze(['user', 'assistant', 'system']);
/** Terminal answer outcomes for this phase; interrupted / clarify statuses arrive in phase 50. */
export const MESSAGE_STATUS_VALUES = Object.freeze(['completed', 'abstained', 'failed']);
/** How strongly an assistant answer is backed by project evidence (backend §60). */
export const MESSAGE_SUPPORT_LEVEL_VALUES = Object.freeze(['evidence_backed', 'insufficient', 'conflict', 'partial']);

const messageSchema = createBaseSchema({
  // Project the parent thread belongs to
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // Chat thread this turn belongs to
  conversationId: { type: ObjectId, ref: 'Conversation', required: true },
  // Who wrote it: user (Alice), assistant (the answer), or system
  role: { type: String, enum: MESSAGE_ROLE_VALUES, required: true },
  // Visible text of the question or answer
  content: { type: String, required: true, default: '' },
  // Terminal outcome of this turn (completed answer, abstain, or failed run)
  messageStatus: { type: String, enum: MESSAGE_STATUS_VALUES, required: true, default: 'completed' },
  // Knowledge snapshot the assistant used to answer
  knowledgeVersionId: { type: ObjectId, ref: 'KnowledgeVersion', default: null },
  // Earlier message this turn replies to, when the thread is branched
  parentMessageId: { type: ObjectId, ref: 'Message', default: null },
  // Source citations for an assistant answer (file, lines) — what the UI inspects
  evidence: { type: mongoose.Schema.Types.Mixed, default: null },
  // Token / model-usage numbers for this turn
  usage: { type: mongoose.Schema.Types.Mixed, default: null },
  // Measured Phase 43 budget for this assistant turn (shown as subtle UI metadata)
  contextMetrics: { type: mongoose.Schema.Types.Mixed, default: null },
  // How grounded the assistant answer is (null until DRAFT/VERIFY finalize)
  supportLevel: { type: String, enum: MESSAGE_SUPPORT_LEVEL_VALUES, default: null },
  // Wall time for the answer run in milliseconds
  durationMs: { type: Number, default: null },
  // Configured LLM model id that produced the draft
  modelId: { type: String, default: null },
  // Enterprise debug linkage (§146): stages, evidence ids, knowledge version — never CoT
  trace: { type: mongoose.Schema.Types.Mixed, default: null },
});

messageSchema.index({ orgId: 1, conversationId: 1, createdAt: 1, _id: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
messageSchema.index({ orgId: 1, projectId: 1, conversationId: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });

export const Message = mongoose.models.Message ?? mongoose.model('Message', messageSchema, 'messages');
