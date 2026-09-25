/**
 * `knowledgeVersions` — one published knowledge graph built from one
 * source snapshot. Chat answers against the project's current published
 * version, not the raw files.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

/** Whether this published graph is ready, only partly usable, or failed. */
export const PUBLISHED_HEALTH_VALUES = Object.freeze([
  'ready',
  'partially_available',
  'failed',
]);

const graphIdentitySchema = new mongoose.Schema(
  {
    // Fingerprint of the published graph; used to detect "same graph"
    graphHash: { type: String, default: null },
    // When the graph was indexed (stamp stored as a string, not a Date)
    indexedAt: { type: String, required: true },
    // Snapshot id recorded inside the graph
    sourceVersionId: { type: String, required: true },
    // How many files were included in this build
    indexedFileCount: { type: Number, required: true, min: 0 },
    // How many files the indexer skipped
    skippedFileCount: { type: Number, required: true, min: 0 },
    // indexAll = built from every file; sync = only files that changed
    mode: { type: String, enum: Object.freeze(['indexAll', 'sync']), required: true },
    // Folder name where the graph files were written
    graphDir: { type: String, required: true, default: '.codegraph' },
  },
  { _id: false },
);

const knowledgeVersionSchema = createBaseSchema({
  // Project this knowledge belongs to (Payments API)
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // File snapshot the graph was built from
  sourceVersionId: { type: ObjectId, ref: 'SourceVersion', required: true },
  // How to find and verify the published graph on disk
  graphIdentity: { type: graphIdentitySchema, required: true },
  // ready = chat can use it; partially_available = some files missing; failed
  publishedHealth: { type: String, enum: PUBLISHED_HEALTH_VALUES, required: true },
  // How many files were left out of this published graph
  excludedFileCount: { type: Number, required: true, min: 0, default: 0 },
  // When this version became the one chat answers from
  publishedAt: { type: Date, required: true, default: () => new Date() },
});

knowledgeVersionSchema.index(
  { orgId: 1, projectId: 1, publishedAt: -1, _id: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);
knowledgeVersionSchema.index(
  { orgId: 1, projectId: 1, sourceVersionId: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const KnowledgeVersion =
  mongoose.models.KnowledgeVersion ??
  mongoose.model('KnowledgeVersion', knowledgeVersionSchema, 'knowledgeVersions');
