/**
 * `knowledgeVersions` — a published knowledge graph built from one source
 * snapshot. Chat answers against the current published version for a project.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

/** Published health values (same vocabulary as project.knowledgeHealth for ready/partial/failed). */
export const PUBLISHED_HEALTH_VALUES = Object.freeze([
  'ready',
  'partially_available',
  'failed',
]);

const graphIdentitySchema = new mongoose.Schema(
  {
    // Content hash of the published graph
    graphHash: { type: String, default: null },
    // When the graph was indexed (identity stamp, not a Date)
    indexedAt: { type: String, required: true },
    // Source version id recorded inside the graph identity
    sourceVersionId: { type: String, required: true },
    // Files included in this graph build
    indexedFileCount: { type: Number, required: true, min: 0 },
    // Files the indexer skipped
    skippedFileCount: { type: Number, required: true, min: 0 },
    // Whether the build indexed everything or applied an incremental sync
    mode: { type: String, enum: Object.freeze(['indexAll', 'sync']), required: true },
    // Directory name where the graph was written
    graphDir: { type: String, required: true, default: '.codegraph' },
  },
  { _id: false },
);

const knowledgeVersionSchema = createBaseSchema({
  // Project this published knowledge belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Source snapshot the graph was built from
  sourceVersionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Codegraph identity used to locate and verify the published graph
  graphIdentity: { type: graphIdentitySchema, required: true },
  // Whether this published version is ready, partial, or failed
  publishedHealth: { type: String, enum: PUBLISHED_HEALTH_VALUES, required: true },
  // Files left out of the graph when this version was published
  excludedFileCount: { type: Number, required: true, min: 0, default: 0 },
  // When this knowledge version became current
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
