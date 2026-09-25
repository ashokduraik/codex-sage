/**
 * `projects` — workspaces that hold source, published knowledge, and chat.
 * Tracks lifecycle, knowledge freshness, and cached counts for the UI.
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
    // Whether the project is fed by upload or a connected repository
    sourceType: { type: String, enum: SOURCE_TYPE_VALUES, required: true },
    // Attached repository, when sourceType is repository
    repositoryConnectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Latest accepted source snapshot used for knowledge
    currentSourceVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const countsSchema = new mongoose.Schema(
  {
    // How many source snapshots this project has accepted
    sourceVersions: { type: Number, required: true, default: 0, min: 0 },
    // How many stored files are in the current snapshot
    files: { type: Number, required: true, default: 0, min: 0 },
    // How many files were kept but left out of the knowledge graph
    excludedFiles: { type: Number, required: true, default: 0, min: 0 },
    // How many chat threads belong to this project
    conversations: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const projectSchema = createBaseSchema({
  // Project title shown in lists and headers
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  // Optional longer summary of what the project is
  description: { type: String, default: '', trim: true, maxlength: 2000 },
  // Where the project is in ingest and knowledge readiness
  lifecycleStatus: { type: String, enum: LIFECYCLE_STATUS_VALUES, required: true, default: 'creating' },
  // Lifecycle to restore when un-archiving
  preArchiveLifecycleStatus: { type: String, enum: LIFECYCLE_STATUS_VALUES, default: null },
  // Machine reason the lifecycle last changed (failure or transition)
  lifecycleStatusReasonCode: { type: String, default: null },
  // When lifecycleStatus last changed
  lifecycleStatusChangedAt: { type: Date, default: () => new Date() },
  // Freshness of published knowledge, orthogonal to lifecycle
  knowledgeHealth: { type: String, enum: KNOWLEDGE_HEALTH_VALUES, required: true, default: 'none' },
  // Published knowledge snapshot currently serving chat
  currentKnowledgeVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // How source arrives and which snapshot is current
  sourceConfig: { type: sourceConfigSchema, required: true },
  // Project-level preferences that do not need dedicated columns
  settings: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Cached totals for list and detail views
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
  // When the project was archived, if it is archived
  archivedAt: { type: Date, default: null },
  // Last time a member opened this project (sorts recents)
  lastAccessedAt: { type: Date, default: null },
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
