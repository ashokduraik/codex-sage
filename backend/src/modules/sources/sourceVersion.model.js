/**
 * SourceVersion Mongoose model — one upload or repository snapshot.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';
import {
  SOURCE_ORIGIN_UPLOAD,
  VERSION_LIFECYCLE_RECEIVED,
  VERSION_LIFECYCLE_VALUES,
} from './sources.constants.js';

const fileCountsSchema = new mongoose.Schema(
  {
    accepted: { type: Number, required: true, min: 0, default: 0 },
    skipped: { type: Number, required: true, min: 0, default: 0 },
    excludedFromGraph: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const sourceVersionSchema = createBaseSchema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  origin: {
    type: String,
    enum: Object.freeze(['upload', 'repository']),
    required: true,
    default: SOURCE_ORIGIN_UPLOAD,
  },
  exclusionRulesetId: {
    type: String,
    required: true,
    trim: true,
  },
  versionLifecycle: {
    type: String,
    enum: VERSION_LIFECYCLE_VALUES,
    required: true,
    default: VERSION_LIFECYCLE_RECEIVED,
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  commitSha: {
    type: String,
    default: null,
    trim: true,
  },
  branch: {
    type: String,
    default: null,
    trim: true,
  },
  repositoryConnectionId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  fileCounts: {
    type: fileCountsSchema,
    required: true,
    default: () => ({ accepted: 0, skipped: 0, excludedFromGraph: 0 }),
  },
});

sourceVersionSchema.index(
  { orgId: 1, projectId: 1, createdAt: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const SourceVersion = mongoose.model('SourceVersion', sourceVersionSchema);
