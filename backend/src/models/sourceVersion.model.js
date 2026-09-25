/**
 * `sourceversions` — one uploaded or repository-synced snapshot of a project's
 * source. Later knowledge and diffs hang off this version.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';
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
    // Files dropped before storage (unsupported or invalid)
    skipped: { type: Number, required: true, min: 0, default: 0 },
    // Stored files left out of the knowledge graph
    excludedFromGraph: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const sourceVersionSchema = createBaseSchema({
  // Project this snapshot belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Whether the snapshot came from an upload or a repository sync
  origin: { type: String, enum: Object.freeze(['upload', 'repository']), required: true, default: SOURCE_ORIGIN_UPLOAD },
  // Exclusion ruleset applied when this snapshot was accepted
  exclusionRulesetId: { type: String, required: true, trim: true },
  // Whether the snapshot is still receiving files, failed, or accepted
  versionLifecycle: { type: String, enum: VERSION_LIFECYCLE_VALUES, required: true, default: VERSION_LIFECYCLE_RECEIVED },
  // Ingest or sync job that produced this snapshot
  jobId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Git commit this snapshot represents, for repository origin
  commitSha: { type: String, default: null, trim: true },
  // Branch the commit was taken from
  branch: { type: String, default: null, trim: true },
  // Repository connection used for a repo-origin snapshot
  repositoryConnectionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Accepted / skipped / excluded totals for this snapshot
  fileCounts: { type: fileCountsSchema, required: true, default: () => ({ accepted: 0, skipped: 0, excludedFromGraph: 0 }) },
});

sourceVersionSchema.index(
  { orgId: 1, projectId: 1, createdAt: -1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const SourceVersion =
  mongoose.models.SourceVersion ?? mongoose.model('SourceVersion', sourceVersionSchema);
