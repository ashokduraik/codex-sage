/**
 * `repositoryConnections` — the Git repo attached to a project.
 * One project has at most one live connection
 * (e.g. github.com/acme/payments on branch main). Holds the host,
 * branch, and whether the last probe or sync worked.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

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

export const CREDENTIAL_KIND_VALUES = Object.freeze(['pat']);

const repositoryCredentialSubSchema = new mongoose.Schema(
  {
    // Encrypted token (never the raw token)
    ciphertext: { type: String, required: true },
    // Random value used when encrypting; needed to decrypt
    iv: { type: String, required: true },
    // Check that the ciphertext was not tampered with
    authTag: { type: String, required: true },
    // Which encryption key was used, so keys can be rotated
    keyId: { type: String, required: true, trim: true },
    // What kind of secret this is (currently a personal access token)
    credentialKind: {
      type: String,
      enum: CREDENTIAL_KIND_VALUES,
      required: true,
      default: 'pat',
    },
    // Last time the token still worked against GitHub/GitLab
    lastValidatedAt: { type: Date, default: null },
    // Unused today: revoke leaves this nested object as-is
    revokedAt: { type: Date, default: null },
  },
  { _id: false },
);

const repositoryConnectionSchema = createBaseSchema({
  // Project this repo is attached to (Payments API)
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // github or gitlab
  provider: { type: String, enum: REPOSITORY_PROVIDER_VALUES, required: true },
  // github, gitlab.com, or a self-hosted GitLab
  hostKind: { type: String, enum: REPOSITORY_HOST_KIND_VALUES, required: true },
  // API URL for self-hosted GitLab; unused for github.com / gitlab.com
  baseUrl: { type: String, default: null },
  // owner/name used to call the host API, e.g. acme/payments
  repositoryFullName: { type: String, required: true, trim: true },
  // Browser URL, e.g. https://github.com/acme/payments
  repositoryWebUrl: { type: String, required: true, trim: true },
  // public or private, as last seen on the host
  visibility: { type: String, default: null },
  // Branch the product syncs, e.g. main
  selectedBranch: { type: String, required: true, trim: true },
  // Default branch on the host when Alice attached the repo
  defaultBranchAtAttach: { type: String, required: true, trim: true },
  // connected, or why it is not: needs auth, denied, missing, unreachable
  connectionStatus: { type: String, enum: CONNECTION_STATUS_VALUES, required: true, default: 'connected' },
  // Machine reason the connection is unhealthy
  connectionStatusReasonCode: { type: String, default: null },
  // Encrypted PAT for this connection; null when attach had no token
  credential: { type: repositoryCredentialSubSchema, default: null },
  // User who attached this repository
  attachedBy: { type: ObjectId, ref: 'User', default: null },
  // When the repository was attached
  attachedAt: { type: Date, default: () => new Date() },
  // Last time a probe confirmed the connection still works
  lastSuccessfulProbeAt: { type: Date, default: null },
  // When Alice last changed selectedBranch
  branchChangedAt: { type: Date, default: null },
  // Commit the last successful sync stored
  lastSyncedCommitSha: { type: String, default: null, trim: true },
  // When the last successful sync finished
  lastSyncedAt: { type: Date, default: null },
  // Next time a periodic sync may run
  nextDueAt: { type: Date, default: () => new Date() },
  // Most recent sync job for this connection
  lastSyncJobId: { type: ObjectId, ref: 'Job', default: null },
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
