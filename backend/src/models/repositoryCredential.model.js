/**
 * `repositoryCredentials` — encrypted host tokens for a repository connection.
 * Never joined into list DTOs; decrypt only in memory when a worker needs them.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

export const CREDENTIAL_KIND_VALUES = Object.freeze(['pat']);

const repositoryCredentialSchema = createBaseSchema({
  // Project the secret belongs to
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // Repository connection this credential authenticates
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  // AES-GCM ciphertext of the token (never stored in the clear)
  ciphertext: { type: String, required: true },
  // Initialization vector used to encrypt the token
  iv: { type: String, required: true },
  // GCM auth tag that proves the ciphertext was not tampered with
  authTag: { type: String, required: true },
  // Which wrapping key encrypted this blob, for rotation
  keyId: { type: String, required: true, trim: true },
  // Kind of secret stored (currently personal access token)
  credentialKind: { type: String, enum: CREDENTIAL_KIND_VALUES, required: true, default: 'pat' },
  // Last time the token was proven valid against the host
  lastValidatedAt: { type: Date, default: null },
  // When the credential was revoked and must not be used
  revokedAt: { type: Date, default: null },
});

repositoryCredentialSchema.index(
  { orgId: 1, projectId: 1, connectionId: 1, status: 1 },
  { partialFilterExpression: { status: ROW_STATUS_ACTIVE } },
);

export const RepositoryCredential =
  mongoose.models.RepositoryCredential ??
  mongoose.model(
    'RepositoryCredential',
    repositoryCredentialSchema,
    'repositoryCredentials',
  );
