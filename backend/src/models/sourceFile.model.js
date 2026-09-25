/**
 * `sourcefiles` — one accepted path inside a source snapshot. Points at the
 * GridFS bytes and records whether the file is in the knowledge graph.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';
export const SOURCE_FILE_KIND_VALUES = Object.freeze(['code', 'config', 'doc']);
export const SOURCE_FILE_STATE_VALUES = Object.freeze([
  'stored',
  'missing',
  'corrupt',
]);
export const SOURCE_FILE_STATE_STORED = 'stored';
export const SOURCE_FILE_STATE_MISSING = 'missing';
export const SOURCE_FILE_STATE_CORRUPT = 'corrupt';

const sourceFileSchema = createBaseSchema({
  // Project this file belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Snapshot that contains this path
  sourceVersionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Repo-relative path of the file
  path: { type: String, required: true, trim: true },
  // Content hash used for change detection
  sha256: { type: String, required: true, trim: true },
  // Stored size in bytes
  byteLength: { type: Number, required: true, min: 0 },
  // How the file is classified: code, config, or doc
  kind: { type: String, enum: SOURCE_FILE_KIND_VALUES, required: true },
  // GridFS object holding the file bytes
  gridFsId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // True when this file is stored but not added to the knowledge graph
  excludedFromGraph: { type: Boolean, required: true, default: false },
  // Why the file was excluded from the graph, when it was
  exclusionReason: { type: String, default: null },
  // Whether bytes are stored, missing, or corrupt
  fileState: { type: String, enum: SOURCE_FILE_STATE_VALUES, required: true, default: SOURCE_FILE_STATE_STORED },
  // When the file became orphaned after a newer snapshot replaced it
  orphanedAt: { type: Date, default: null },
});

sourceFileSchema.index(
  { orgId: 1, projectId: 1, sourceVersionId: 1, path: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ROW_STATUS_ACTIVE },
  },
);

export const SourceFile =
  mongoose.models.SourceFile ?? mongoose.model('SourceFile', sourceFileSchema);
