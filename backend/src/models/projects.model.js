/**
 * `projects` — one workspace inside an org (e.g. "Payments API").
 * Holds how source arrives, whether knowledge is ready for chat, and
 * cached file/conversation counts for the project list.
 *
 * `lifecycleStatus` is setup/ingest progress (awaiting source, processing,
 * knowledge ready, archived). `knowledgeHealth` is whether chat has good
 * knowledge (none, ready, stale). Those two can differ.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** Setup/ingest progress for a project. */
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

/** Whether chat has usable knowledge (independent of lifecycleStatus). */
export const KNOWLEDGE_HEALTH_VALUES = Object.freeze([
  'none',
  'updating',
  'ready',
  'partially_available',
  'stale',
  'failed',
]);

/** How files arrive: Alice uploads a zip, or a Git repo is connected. */
export const SOURCE_TYPE_VALUES = Object.freeze(['upload', 'repository']);

const sourceConfigSchema = new mongoose.Schema(
  {
    // How files arrive: Alice uploads a zip, or a Git repo is connected
    sourceType: { type: String, enum: SOURCE_TYPE_VALUES, required: true },
    // The connected Git repo, when sourceType is repository
    repositoryConnectionId: { type: ObjectId, ref: 'RepositoryConnection', default: null },
    // Latest accepted file snapshot this project is using
    currentSourceVersionId: { type: ObjectId, ref: 'SourceVersion', default: null },
  },
  { _id: false },
);

const countsSchema = new mongoose.Schema(
  {
    // How many file snapshots this project has accepted
    sourceVersions: { type: Number, required: true, default: 0, min: 0 },
    // How many files are in the current snapshot
    files: { type: Number, required: true, default: 0, min: 0 },
    // How many of those files are stored but left out of knowledge
    excludedFiles: { type: Number, required: true, default: 0, min: 0 },
    // How many chat threads belong to this project
    conversations: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const projectSchema = createBaseSchema({
  // Title shown in lists, e.g. "Payments API"
  name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  // Optional longer summary of what the project is
  description: { type: String, default: '', trim: true, maxlength: 2000 },
  // Setup/ingest progress: creating, awaiting source, processing, ready, archived
  lifecycleStatus: { type: String, enum: LIFECYCLE_STATUS_VALUES, required: true, default: 'creating' },
  // Status to put back when someone un-archives the project
  preArchiveLifecycleStatus: { type: String, enum: LIFECYCLE_STATUS_VALUES, default: null },
  // Machine reason the last lifecycle change happened (e.g. ingest failed)
  lifecycleStatusReasonCode: { type: String, default: null },
  // When lifecycleStatus last changed
  lifecycleStatusChangedAt: { type: Date, default: () => new Date() },
  // Whether chat has usable knowledge: none, updating, ready, stale, failed
  knowledgeHealth: { type: String, enum: KNOWLEDGE_HEALTH_VALUES, required: true, default: 'none' },
  // Published knowledge chat is answering from right now
  currentKnowledgeVersionId: { type: ObjectId, ref: 'KnowledgeVersion', default: null },
  // How files arrive and which snapshot is current
  sourceConfig: { type: sourceConfigSchema, required: true },
  // Extra project preferences that do not need their own column
  settings: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  // Cached totals shown on the project list and detail pages
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
  // When the project was archived; null if it is still open
  archivedAt: { type: Date, default: null },
  // Last time a member opened this project (sorts "recent")
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
