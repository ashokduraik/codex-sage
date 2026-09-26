/**
 * `sourcefiles` — one file inside one snapshot.
 * Example: src/auth.js in upload #3. The bytes live in GridFS
 * (`gridFsId`); this row is the path, size, hash, and whether
 * knowledge should include it.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

export const SOURCE_FILE_KIND_VALUES = Object.freeze(['code', 'config', 'doc']);
export const SOURCE_FILE_STATE_VALUES = Object.freeze(['stored', 'missing', 'corrupt']);
export const SOURCE_FILE_STATE_STORED = 'stored';
export const SOURCE_FILE_STATE_MISSING = 'missing';
export const SOURCE_FILE_STATE_CORRUPT = 'corrupt';

const sourceFileSchema = createBaseSchema({
  // Project this file belongs to
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // Snapshot this file is part of (upload #3)
  sourceVersionId: { type: ObjectId, ref: 'SourceVersion', required: true },
  // Path inside the snapshot, e.g. src/auth.js
  path: { type: String, required: true, trim: true },
  // Content hash; used to see if the file changed in the next snapshot
  sha256: { type: String, required: true, trim: true },
  // Size of the stored bytes
  byteLength: { type: Number, required: true, min: 0 },
  // code, config, or doc — how the file is classified
  kind: { type: String, enum: SOURCE_FILE_KIND_VALUES, required: true },
  // Where the file bytes are stored (GridFS object id)
  gridFsId: { type: ObjectId, required: true },
  // True if the file is stored but knowledge must not use it
  excludedFromGraph: { type: Boolean, required: true, default: false },
  // Why it was excluded, when excludedFromGraph is true
  exclusionReason: { type: String, default: null },
  // stored = bytes are there; missing / corrupt = cannot be read
  fileState: { type: String, enum: SOURCE_FILE_STATE_VALUES, required: true, default: SOURCE_FILE_STATE_STORED },
  // When a newer snapshot replaced this file and these bytes are leftover
  orphanedAt: { type: Date, default: null },
});

sourceFileSchema.index(
  { orgId: 1, projectId: 1, sourceVersionId: 1, path: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ROW_STATUS_ACTIVE },
  },
);

export const SourceFile = mongoose.models.SourceFile ?? mongoose.model('SourceFile', sourceFileSchema);
