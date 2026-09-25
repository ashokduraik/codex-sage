/**
 * `sourceversions` — one snapshot of a project's files.
 * Example: Alice uploaded a zip, or a repo sync stored commit abc123.
 * Knowledge and file diffs are built from this snapshot, not live disk.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

export const SOURCE_ORIGIN_UPLOAD = 'upload';
export const SOURCE_ORIGIN_REPOSITORY = 'repository';
export const VERSION_LIFECYCLE_VALUES = Object.freeze([
  'received',
  'failed',
  'accepted',
]);
export const VERSION_LIFECYCLE_RECEIVED = 'received';

const fileCountsSchema = new mongoose.Schema(
  {
    // Files stored and eligible for knowledge
    accepted: { type: Number, required: true, min: 0, default: 0 },
    // Files dropped before storage (unsupported type or invalid)
    skipped: { type: Number, required: true, min: 0, default: 0 },
    // Stored files left out of knowledge on purpose
    excludedFromGraph: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const sourceVersionSchema = createBaseSchema({
  // Project these files belong to (Payments API)
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // upload = Alice's zip; repository = a Git sync
  origin: { type: String, enum: Object.freeze(['upload', 'repository']), required: true, default: SOURCE_ORIGIN_UPLOAD },
  // Which exclusion rules were applied when this snapshot was accepted
  exclusionRulesetId: { type: String, required: true, trim: true },
  // received = still taking files; accepted = ready; failed = rejected
  versionLifecycle: { type: String, enum: VERSION_LIFECYCLE_VALUES, required: true, default: VERSION_LIFECYCLE_RECEIVED },
  // Ingest or sync job that created this snapshot
  jobId: { type: ObjectId, ref: 'Job', default: null },
  // Git commit this snapshot is, when origin is repository
  commitSha: { type: String, default: null, trim: true },
  // Branch that commit was taken from, e.g. main
  branch: { type: String, default: null, trim: true },
  // Connected repo this snapshot came from, when origin is repository
  repositoryConnectionId: { type: ObjectId, ref: 'RepositoryConnection', default: null },
  // How many files were accepted, skipped, or excluded
  fileCounts: { type: fileCountsSchema, required: true, default: () => ({ accepted: 0, skipped: 0, excludedFromGraph: 0 }) },
});

sourceVersionSchema.index(
  { orgId: 1, projectId: 1, createdAt: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const SourceVersion =
  mongoose.models.SourceVersion ?? mongoose.model('SourceVersion', sourceVersionSchema);
