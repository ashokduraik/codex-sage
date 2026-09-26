/**
 * `sourceChangeSummaries` — what changed between this snapshot and
 * the last one (added, removed, changed, unchanged paths).
 * Used so knowledge can update only the files that moved.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

export const SOURCE_DIFF_STATUS_VALUES = Object.freeze(['pending', 'computed', 'failed']);

const pathSetsSchema = new mongoose.Schema(
  {
    // Files that exist only in this snapshot (new)
    added: { type: [String], required: true, default: () => [] },
    // Files that existed only in the previous snapshot (deleted)
    removed: { type: [String], required: true, default: () => [] },
    // Files whose content hash changed (edited)
    changed: { type: [String], required: true, default: () => [] },
    // Files whose content hash stayed the same
    unchanged: { type: [String], required: true, default: () => [] },
  },
  { _id: false },
);

const countsSchema = new mongoose.Schema(
  {
    // How many files were added
    added: { type: Number, required: true, min: 0, default: 0 },
    // How many files were removed
    removed: { type: Number, required: true, min: 0, default: 0 },
    // How many files were edited
    changed: { type: Number, required: true, min: 0, default: 0 },
    // How many files stayed the same
    unchanged: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const sourceChangeSummarySchema = createBaseSchema({
  // Project this comparison belongs to
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // Newer snapshot being compared (this upload / this commit)
  sourceVersionId: { type: ObjectId, ref: 'SourceVersion', required: true },
  // Previous snapshot to compare against; null if this is the first
  previousSourceVersionId: { type: ObjectId, ref: 'SourceVersion', default: null },
  // Knowledge built from this snapshot, when it has been published
  knowledgeVersionId: { type: ObjectId, ref: 'KnowledgeVersion', default: null },
  // How many files were added, removed, changed, or unchanged
  counts: { type: countsSchema, required: true, default: () => ({ added: 0, removed: 0, changed: 0, unchanged: 0 }) },
  // The actual file paths in each bucket
  paths: { type: pathSetsSchema, required: true, default: () => ({ added: [], removed: [], changed: [], unchanged: [] }) },
  // When the comparison finished
  computedAt: { type: Date, default: null },
  // pending = not done yet; computed = ready; failed = could not compare
  diffStatus: { type: String, enum: SOURCE_DIFF_STATUS_VALUES, required: true, default: 'pending' },
});

sourceChangeSummarySchema.index(
  { orgId: 1, projectId: 1, sourceVersionId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ROW_STATUS_ACTIVE },
  },
);

sourceChangeSummarySchema.index({ orgId: 1, projectId: 1, createdAt: -1 }, { partialFilterExpression: { status: ROW_STATUS_ACTIVE } });

export const SourceChangeSummary =
  mongoose.models.SourceChangeSummary ?? mongoose.model('SourceChangeSummary', sourceChangeSummarySchema, 'sourceChangeSummaries');
