/**
 * AES-256-GCM secret encryption for repository credentials (Phase 30).
 * Decrypt only in memory; never log plaintext or ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

/**
 * Decodes and validates the 32-byte AES key from base64.
 * @param {string} base64Key Env value.
 * @returns {Buffer} Raw key bytes.
 * @throws {Error} When the value is missing or the wrong length.
 */
export function parseEncryptionKey(base64Key) {
  if (typeof base64Key !== 'string' || base64Key.trim() === '') {
    throw new Error('REPO_CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64');
  }
  const key = Buffer.from(base64Key.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('REPO_CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64');
  }
  return key;
}

/**
 * Encrypts a UTF-8 secret with a random IV.
 * @param {string} plaintext Secret to encrypt.
 * @param {Buffer} key 32-byte AES key.
 * @param {string} keyId Key id stored with the ciphertext for rotation.
 * @returns {{ ciphertext: string, iv: string, authTag: string, keyId: string }}
 */
export function encryptSecret(plaintext, key, keyId) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error('REPO_CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64');
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyId: String(keyId),
  };
}

/**
 * Decrypts a payload produced by {@link encryptSecret}.
 * @param {{ ciphertext: string, iv: string, authTag: string }} payload Stored fields.
 * @param {Buffer} key 32-byte AES key that matches the payload key id.
 * @returns {string} UTF-8 plaintext.
 * @throws {Error} When the payload is tampered or the key is wrong.
 */
export function decryptSecret(payload, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error('REPO_CREDENTIAL_ENCRYPTION_KEY must be 32-byte base64');
  }
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
