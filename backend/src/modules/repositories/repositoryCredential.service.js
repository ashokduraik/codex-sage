/**
 * Encrypt / decrypt / rotate repository credentials. Decrypt only in memory.
 */
import { ApiError } from '../../platform/errors.js';
import { resolveRepositoryCrypto } from '../../platform/config.js';
import { decryptSecret, encryptSecret } from '../../platform/secretCrypto.js';
import {
  findActiveCredential,
  insertCredential,
  softDeleteCredential,
  updateConnection,
} from './repositories.repository.js';

export const REPO_CREDENTIAL_MAX_ACTIVE_PER_CONNECTION = 1;

/**
 * Encrypts a PAT and inserts a new active credential row.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   connectionId: string,
 *   accessToken: string,
 *   createdBy: string,
 * }} input Fields.
 * @param {{ session?: import('mongoose').ClientSession }} [options] Session.
 * @returns {Promise<{ credentialId: string }>}
 */
export async function storeEncryptedCredential(input, options = {}) {
  const crypto = resolveRepositoryCrypto();
  const sealed = encryptSecret(input.accessToken, crypto.encryptionKey, crypto.keyId);
  const doc = await insertCredential(
    {
      orgId: input.orgId,
      projectId: input.projectId,
      connectionId: input.connectionId,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      keyId: sealed.keyId,
      credentialKind: 'pat',
      lastValidatedAt: new Date(),
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    },
    options,
  );
  return { credentialId: String(doc._id) };
}

/**
 * Decrypts the active credential for a connection. Never logs the plaintext.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   credentialId: string,
 * }} input Scope.
 * @returns {Promise<string>}
 */
export async function decryptConnectionToken(input) {
  const row = await findActiveCredential(input);
  if (!row) {
    throw ApiError.fromCode('NOT_FOUND');
  }
  try {
    const crypto = resolveRepositoryCrypto();
    return decryptSecret(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag },
      crypto.encryptionKey,
    );
  } catch {
    throw ApiError.fromCode('CREDENTIAL_DECRYPT_FAILED');
  }
}

/**
 * Soft-deletes the prior credential and inserts a replacement.
 * @param {{
 *   orgId: string,
 *   projectId: string,
 *   connectionId: string,
 *   previousCredentialId: string | null,
 *   accessToken: string,
 *   actorUserId: string,
 * }} input Rotate fields.
 * @returns {Promise<{ credentialId: string }>}
 */
export async function replaceEncryptedCredential(input) {
  if (input.previousCredentialId) {
    await softDeleteCredential({
      orgId: input.orgId,
      credentialId: input.previousCredentialId,
    });
  }
  const stored = await storeEncryptedCredential({
    orgId: input.orgId,
    projectId: input.projectId,
    connectionId: input.connectionId,
    accessToken: input.accessToken,
    createdBy: input.actorUserId,
  });
  await updateConnection({
    orgId: input.orgId,
    connectionId: input.connectionId,
    set: { credentialId: stored.credentialId, updatedBy: input.actorUserId },
  });
  return stored;
}
