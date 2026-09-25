/**
 * `repositoryCredentials` — the encrypted GitHub/GitLab token for one
 * connection. The raw token is never stored. Workers decrypt it in
 * memory only when they sync. List APIs must not return these fields.
 */
import mongoose from 'mongoose';
import { createBaseSchema, ROW_STATUS_ACTIVE } from '../platform/data/index.js';

const ObjectId = mongoose.Schema.Types.ObjectId;

export const CREDENTIAL_KIND_VALUES = Object.freeze(['pat']);

const repositoryCredentialSchema = createBaseSchema({
  // Project this secret belongs to
  projectId: { type: ObjectId, ref: 'Project', required: true },
  // Repository connection this token opens
  connectionId: { type: ObjectId, ref: 'RepositoryConnection', required: true },
  // Encrypted token (never the raw token)
  ciphertext: { type: String, required: true },
  // Random value used when encrypting; needed to decrypt
  iv: { type: String, required: true },
  // Check that the ciphertext was not tampered with
  authTag: { type: String, required: true },
  // Which encryption key was used, so keys can be rotated
  keyId: { type: String, required: true, trim: true },
  // What kind of secret this is (currently a personal access token)
  credentialKind: { type: String, enum: CREDENTIAL_KIND_VALUES, required: true, default: 'pat' },
  // Last time the token still worked against GitHub/GitLab
  lastValidatedAt: { type: Date, default: null },
  // When the token was revoked and must not be used again
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
