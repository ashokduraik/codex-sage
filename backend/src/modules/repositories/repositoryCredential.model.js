/**
 * RepositoryCredential — encrypted PAT storage; never joined into list DTOs.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../../platform/data/index.js';

export const CREDENTIAL_KIND_VALUES = Object.freeze(['pat']);

const repositoryCredentialSchema = createBaseSchema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  ciphertext: { type: String, required: true },
  iv: { type: String, required: true },
  authTag: { type: String, required: true },
  keyId: { type: String, required: true, trim: true },
  credentialKind: {
    type: String,
    enum: CREDENTIAL_KIND_VALUES,
    required: true,
    default: 'pat',
  },
  lastValidatedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
});

repositoryCredentialSchema.index(
  { orgId: 1, projectId: 1, connectionId: 1, status: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const RepositoryCredential = mongoose.model(
  'RepositoryCredential',
  repositoryCredentialSchema,
  'repositoryCredentials',
);
