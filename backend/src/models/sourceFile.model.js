/**
 * SourceFile Mongoose model — one accepted path within a SourceVersion.
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
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  sourceVersionId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  path: {
    type: String,
    required: true,
    trim: true,
  },
  sha256: {
    type: String,
    required: true,
    trim: true,
  },
  byteLength: {
    type: Number,
    required: true,
    min: 0,
  },
  kind: {
    type: String,
    enum: SOURCE_FILE_KIND_VALUES,
    required: true,
  },
  gridFsId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  excludedFromGraph: {
    type: Boolean,
    required: true,
    default: false,
  },
  exclusionReason: {
    type: String,
    default: null,
  },
  fileState: {
    type: String,
    enum: SOURCE_FILE_STATE_VALUES,
    required: true,
    default: SOURCE_FILE_STATE_STORED,
  },
  orphanedAt: {
    type: Date,
    default: null,
  },
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
