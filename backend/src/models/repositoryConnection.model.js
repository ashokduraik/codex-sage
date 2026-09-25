/**
 * `repositoryConnections` — the one Git repository attached to a project.
 * Holds host identity, selected branch, connectivity, and last-sync state.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

export const CONNECTION_STATUS_VALUES = Object.freeze([
  'connected',
  'authentication_required',
  'access_denied',
  'not_found',
  'unreachable',
]);

export const REPOSITORY_PROVIDER_VALUES = Object.freeze(['github', 'gitlab']);

export const REPOSITORY_HOST_KIND_VALUES = Object.freeze([
  'github',
  'gitlab_saas',
  'gitlab_self_hosted',
]);

const repositoryConnectionSchema = createBaseSchema({
  // Project this repository is attached to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Git host vendor (github or gitlab)
  provider: { type: String, enum: REPOSITORY_PROVIDER_VALUES, required: true },
  // Host flavor: GitHub, GitLab SaaS, or self-hosted GitLab
  hostKind: { type: String, enum: REPOSITORY_HOST_KIND_VALUES, required: true },
  // API origin for self-hosted GitLab; unused for SaaS defaults
  baseUrl: { type: String, default: null },
  // owner/name used to call the host API
  repositoryFullName: { type: String, required: true, trim: true },
  // Browser URL of the repository
  repositoryWebUrl: { type: String, required: true, trim: true },
  // Public/private (or host-specific) visibility at last probe
  visibility: { type: String, default: null },
  // Branch the product syncs
  selectedBranch: { type: String, required: true, trim: true },
  // Default branch observed when the repo was attached
  defaultBranchAtAttach: { type: String, required: true, trim: true },
  // Live connectivity: connected, auth required, denied, missing, or unreachable
  connectionStatus: { type: String, enum: CONNECTION_STATUS_VALUES, required: true, default: 'connected' },
  // Machine reason the connection is not healthy
  connectionStatusReasonCode: { type: String, default: null },
  // Encrypted credential used to call the host
  credentialId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // User who attached this repository
  attachedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  // When the repository was attached
  attachedAt: { type: Date, default: () => new Date() },
  // Last time a probe confirmed the connection still works
  lastSuccessfulProbeAt: { type: Date, default: null },
  // When selectedBranch last changed
  branchChangedAt: { type: Date, default: null },
  // Commit the last successful sync stored
  lastSyncedCommitSha: { type: String, default: null, trim: true },
  // When the last successful sync finished
  lastSyncedAt: { type: Date, default: null },
  // Next time a periodic sync may run
  nextDueAt: { type: Date, default: () => new Date() },
  // Most recent sync job for this connection
  lastSyncJobId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Machine code from the last failed sync
  lastSyncErrorCode: { type: String, default: null },
});

repositoryConnectionSchema.index(
  { orgId: 1, projectId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: ROW_STATUS_ACTIVE },
  },
);

repositoryConnectionSchema.index(
  { orgId: 1, projectId: 1, status: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

repositoryConnectionSchema.index(
  { nextDueAt: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const RepositoryConnection =
  mongoose.models.RepositoryConnection ??
  mongoose.model(
    'RepositoryConnection',
    repositoryConnectionSchema,
    'repositoryConnections',
  );
