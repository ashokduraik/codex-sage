/**
 * Project Mongoose model — tenant-scoped lifecycle and knowledge health.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

/** Project lifecycle states (backend §9). */
export const LIFECYCLE_STATUS_VALUES = Object.freeze([
  'creating',
  'awaiting_source',
  'connecting_repository',
  'source_received',
  'processing',
  'knowledge_ready',
  'updating',
  'failed',
  'partially_available',
  'archived',
]);

/** Knowledge freshness enum (orthogonal to lifecycle). */
export const KNOWLEDGE_HEALTH_VALUES = Object.freeze([
  'none',
  'updating',
  'ready',
  'partially_available',
  'stale',
  'failed',
]);

/** How the project expects its first source. */
export const SOURCE_TYPE_VALUES = Object.freeze(['upload', 'repository']);

const sourceConfigSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      enum: SOURCE_TYPE_VALUES,
      required: true,
    },
    repositoryConnectionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    currentSourceVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { _id: false },
);

const countsSchema = new mongoose.Schema(
  {
    sourceVersions: { type: Number, required: true, default: 0, min: 0 },
    files: { type: Number, required: true, default: 0, min: 0 },
    excludedFiles: { type: Number, required: true, default: 0, min: 0 },
    conversations: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const projectSchema = createBaseSchema({
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 120,
  },
  description: {
    type: String,
    default: '',
    trim: true,
    maxlength: 2000,
  },
  lifecycleStatus: {
    type: String,
    enum: LIFECYCLE_STATUS_VALUES,
    required: true,
    default: 'creating',
  },
  preArchiveLifecycleStatus: {
    type: String,
    enum: LIFECYCLE_STATUS_VALUES,
    default: null,
  },
  lifecycleStatusReasonCode: {
    type: String,
    default: null,
  },
  lifecycleStatusChangedAt: {
    type: Date,
    default: () => new Date(),
  },
  knowledgeHealth: {
    type: String,
    enum: KNOWLEDGE_HEALTH_VALUES,
    required: true,
    default: 'none',
  },
  currentKnowledgeVersionId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  sourceConfig: {
    type: sourceConfigSchema,
    required: true,
  },
  settings: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },
  counts: {
    type: countsSchema,
    required: true,
    default: () => ({
      sourceVersions: 0,
      files: 0,
      excludedFiles: 0,
      conversations: 0,
    }),
  },
  archivedAt: {
    type: Date,
    default: null,
  },
  lastAccessedAt: {
    type: Date,
    default: null,
  },
});

projectSchema.index(
  { orgId: 1, updatedAt: -1, _id: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
projectSchema.index(
  { orgId: 1, lastAccessedAt: -1, _id: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
projectSchema.index(
  { orgId: 1, lifecycleStatus: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const Project =
  mongoose.models.Project ?? mongoose.model('Project', projectSchema, 'projects');
