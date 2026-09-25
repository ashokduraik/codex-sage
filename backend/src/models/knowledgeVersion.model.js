/**
 * KnowledgeVersion Mongoose model — published graph identity for a source version.
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
    graphHash: { type: String, default: null },
    indexedAt: { type: String, required: true },
    sourceVersionId: { type: String, required: true },
    indexedFileCount: { type: Number, required: true, min: 0 },
    skippedFileCount: { type: Number, required: true, min: 0 },
    mode: { type: String, enum: Object.freeze(['indexAll', 'sync']), required: true },
    graphDir: { type: String, required: true, default: '.codegraph' },
  },
  { _id: false },
);

const knowledgeVersionSchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  sourceVersionId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  graphIdentity: {
    type: graphIdentitySchema,
    required: true,
  },
  publishedHealth: {
    type: String,
    enum: PUBLISHED_HEALTH_VALUES,
    required: true,
  },
  excludedFileCount: {
    type: Number,
    required: true,
    min: 0,
    default: 0,
  },
  publishedAt: {
    type: Date,
    required: true,
    default: () => new Date(),
  },
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
