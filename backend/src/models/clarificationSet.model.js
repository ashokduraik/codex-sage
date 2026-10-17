/**
 * `clarificationSets` — user-visible clarification questions and answers for one
 * assistant chat turn so refresh can rehydrate the wizard and answer POST can resume.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** Domain lifecycle for a clarification set (not row `status`). */
export const CLARIFICATION_SET_STATUS_VALUES = Object.freeze(['open', 'answered', 'superseded']);

/** Allowed question types for a clarification set (backend §53). */
export const CLARIFICATION_SET_QUESTION_TYPES = Object.freeze(['single_select', 'multi_select', 'free_text']);

const clarificationQuestionSchema = new mongoose.Schema(
  {
    // Stable id within the set (e.g. q1) — answer map key
    id: { type: String, required: true, trim: true },
    // single_select | multi_select | free_text
    type: { type: String, enum: CLARIFICATION_SET_QUESTION_TYPES, required: true },
    // User-facing question text
    prompt: { type: String, required: true, trim: true },
    // Select options as plain strings (graph/SSE contract)
    options: { type: [String], default: undefined },
    // When false, answer may be omitted; default treated as required in service
    required: { type: Boolean, default: true },
  },
  { _id: false },
);

const clarificationSetSchema = createBaseSchema({
  // Project the assistant turn belongs to
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // Chat thread for the turn
  conversationId: { type: ObjectId, ref: 'Conversation', required: true },
  // Assistant message paused at awaiting_clarification
  messageId: { type: ObjectId, ref: 'Message', required: true },
  // Public id matching graph interrupt / SSE (e.g. clr_r0_…)
  clarificationSetId: { type: String, required: true, trim: true },
  // 0 = initial set, 1 = follow-up (matches LangGraph roundIndex)
  roundIndex: { type: Number, required: true, min: 0, max: 1 },
  // open until answers POST; answered after submit; superseded when a newer open set replaces it
  setStatus: { type: String, enum: CLARIFICATION_SET_STATUS_VALUES, required: true, default: 'open' },
  // Full question list for the UI (never secrets or model CoT)
  questions: { type: [clarificationQuestionSchema], required: true, default: [] },
  // questionId → string | string[]; null until the user POSTs answers
  answers: { type: mongoose.Schema.Types.Mixed, default: null },
  // When the set was issued from the graph interrupt
  issuedAt: { type: Date, required: true },
});

clarificationSetSchema.index({ orgId: 1, clarificationSetId: 1 }, { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
clarificationSetSchema.index({ orgId: 1, messageId: 1, setStatus: 1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });

export const ClarificationSet = mongoose.models.ClarificationSet ?? mongoose.model('ClarificationSet', clarificationSetSchema, 'clarificationSets');
