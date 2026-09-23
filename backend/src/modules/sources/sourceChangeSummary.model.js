/**
 * SourceChangeSummary — persisted path+sha256 diff for a source version (Phase 29).
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

export const SOURCE_DIFF_STATUS_VALUES = Object.freeze([
  'pending',
  'computed',
  'failed',
]);

const pathSetsSchema = new mongoose.Schema(
  {
    added: { type: [String], required: true, default: () => [] },
    removed: { type: [String], required: true, default: () => [] },
    changed: { type: [String], required: true, default: () => [] },
    unchanged: { type: [String], required: true, default: () => [] },
  },
  { _id: false },
);

const countsSchema = new mongoose.Schema(
  {
    added: { type: Number, required: true, min: 0, default: 0 },
    removed: { type: Number, required: true, min: 0, default: 0 },
    changed: { type: Number, required: true, min: 0, default: 0 },
    unchanged: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const sourceChangeSummarySchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  sourceVersionId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  previousSourceVersionId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  knowledgeVersionId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  counts: {
    type: countsSchema,
    required: true,
    default: () => ({ added: 0, removed: 0, changed: 0, unchanged: 0 }),
  },
  paths: {
    type: pathSetsSchema,
    required: true,
    default: () => ({ added: [], removed: [], changed: [], unchanged: [] }),
  },
  computedAt: {
    type: Date,
    default: null,
  },
  diffStatus: {
    type: String,
    enum: SOURCE_DIFF_STATUS_VALUES,
    required: true,
    default: 'pending',
  },
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

export const SourceChangeSummary = mongoose.model(
  'SourceChangeSummary',
  sourceChangeSummarySchema,
  'sourceChangeSummaries',
);
