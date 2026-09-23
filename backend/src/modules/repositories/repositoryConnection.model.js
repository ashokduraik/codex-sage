/**
 * RepositoryConnection — one active attached repository per project.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

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
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  provider: { type: String, enum: REPOSITORY_PROVIDER_VALUES, required: true },
  hostKind: { type: String, enum: REPOSITORY_HOST_KIND_VALUES, required: true },
  baseUrl: { type: String, default: null },
  repositoryFullName: { type: String, required: true, trim: true },
  repositoryWebUrl: { type: String, required: true, trim: true },
  visibility: { type: String, default: null },
  selectedBranch: { type: String, required: true, trim: true },
  defaultBranchAtAttach: { type: String, required: true, trim: true },
  connectionStatus: {
    type: String,
    enum: CONNECTION_STATUS_VALUES,
    required: true,
    default: 'connected',
  },
  connectionStatusReasonCode: { type: String, default: null },
  credentialId: { type: mongoose.Schema.Types.ObjectId, default: null },
  attachedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  attachedAt: { type: Date, default: () => new Date() },
  lastSuccessfulProbeAt: { type: Date, default: null },
  branchChangedAt: { type: Date, default: null },
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

export const RepositoryConnection = mongoose.model(
  'RepositoryConnection',
  repositoryConnectionSchema,
  'repositoryConnections',
);
