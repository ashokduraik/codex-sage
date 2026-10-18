/**
 * `projectActivities` — one observed project fact (ingest, search, answered question, or LLM tokens).
 * Example: one finished ingest job, a successful search, or tokens reported for a completed answer.
 * Usage GETs sum these rows by `occurredAt`. Duplicate `dedupeKey` values are rejected.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** Observed activity kinds. Question/token kinds are written only from assistant finalize. */
export const PROJECT_ACTIVITY_KIND_VALUES = Object.freeze([
  'ingest.job.completed',
  'source.bytes.accepted',
  'search.executed',
  'question.answered',
  'tokens.input',
  'tokens.output',
]);

const projectActivitySchema = createBaseSchema({
  // Project the fact belongs to (Payments API). Required — skip the write if missing.
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // Who triggered the work when known (job createdBy, search caller, or chat actor)
  userId: { type: ObjectId, ref: 'User', default: null },
  // What was observed — one of PROJECT_ACTIVITY_KIND_VALUES
  kind: { type: String, enum: PROJECT_ACTIVITY_KIND_VALUES, required: true },
  // How much (1 job, N bytes, 1 search/question, N tokens). Never a guess.
  quantity: { type: Number, required: true, min: 0 },
  // Unit label for the quantity (jobs, bytes, calls, count, tokens)
  unit: { type: String, required: true, trim: true },
  // Stable pointer back to the source of the fact (job id, message id, request id)
  sourceRef: { type: String, required: true, trim: true },
  // Unique per org so a worker retry does not double-count
  dedupeKey: { type: String, required: true, trim: true },
  // When the fact happened (UTC). Reads and retention filter on this instant.
  occurredAt: { type: Date, required: true },
});

// One active fact per org + dedupeKey
projectActivitySchema.index({ orgId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
projectActivitySchema.index({ orgId: 1, projectId: 1, occurredAt: -1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });
projectActivitySchema.index({ orgId: 1, userId: 1, occurredAt: -1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });

export const ProjectActivity = mongoose.models.ProjectActivity ?? mongoose.model('ProjectActivity', projectActivitySchema, 'projectActivities');
