/**
 * `sourceChangeSummaries` — persisted path-and-hash diff between this source
 * snapshot and the previous one, used to drive incremental knowledge updates.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

export const SOURCE_DIFF_STATUS_VALUES = Object.freeze([
  'pending',
  'computed',
  'failed',
]);

const pathSetsSchema = new mongoose.Schema(
  {
    // Paths present only in this snapshot
    added: { type: [String], required: true, default: () => [] },
    // Paths present only in the previous snapshot
    removed: { type: [String], required: true, default: () => [] },
    // Paths whose content hash changed
    changed: { type: [String], required: true, default: () => [] },
    // Paths whose content hash stayed the same
    unchanged: { type: [String], required: true, default: () => [] },
  },
  { _id: false },
);

const countsSchema = new mongoose.Schema(
  {
    // Number of added paths
    added: { type: Number, required: true, min: 0, default: 0 },
    // Number of removed paths
    removed: { type: Number, required: true, min: 0, default: 0 },
    // Number of changed paths
    changed: { type: Number, required: true, min: 0, default: 0 },
    // Number of unchanged paths
    unchanged: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const sourceChangeSummarySchema = createBaseSchema({
  // Project this diff belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Snapshot the diff was computed for
  sourceVersionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Prior snapshot used as the diff baseline, if one exists
  previousSourceVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Knowledge version published from this snapshot, when ready
  knowledgeVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Added / removed / changed / unchanged path totals
  counts: { type: countsSchema, required: true, default: () => ({ added: 0, removed: 0, changed: 0, unchanged: 0 }) },
  // Path lists for each diff bucket
  paths: { type: pathSetsSchema, required: true, default: () => ({ added: [], removed: [], changed: [], unchanged: [] }) },
  // When the diff finished computing
  computedAt: { type: Date, default: null },
  // Whether the diff is pending, computed, or failed
  diffStatus: { type: String, enum: SOURCE_DIFF_STATUS_VALUES, required: true, default: 'pending' },
});

sourceChangeSummarySchema.index(
  { orgId: 1, projectId: 1, sourceVersionId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ROW_STATUS_ACTIVE },
  },
);

sourceChangeSummarySchema.index(
  { orgId: 1, projectId: 1, createdAt: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const SourceChangeSummary =
  mongoose.models.SourceChangeSummary ??
  mongoose.model(
    'SourceChangeSummary',
    sourceChangeSummarySchema,
    'sourceChangeSummaries',
  );
