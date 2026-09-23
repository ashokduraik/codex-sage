/**
 * AES-256-GCM secretCrypto unit tests.
 */
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseEncryptionKey } from './secretCrypto.js';

const KEY = parseEncryptionKey(Buffer.alloc(32, 9).toString('base64'));

describe('secretCrypto', () => {
  it('round-trips a value and produces different ciphertext per call', () => {
    const first = encryptSecret('ghp_example_token', KEY, 'k1');
    const second = encryptSecret('ghp_example_token', KEY, 'k1');
    expect(first.keyId).toBe('k1');
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
    expect(decryptSecret(first, KEY)).toBe('ghp_example_token');
    expect(decryptSecret(second, KEY)).toBe('ghp_example_token');
  });

  it('rejects a tampered payload', () => {
    const sealed = encryptSecret('secret', KEY, 'k1');
    const tampered = {
      ...sealed,
      ciphertext: Buffer.from('not-the-original').toString('base64'),
    };
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('fails loudly on a wrong-length key', () => {
    expect(() => parseEncryptionKey('short')).toThrow(/32-byte base64/);
    expect(() => parseEncryptionKey('')).toThrow(/32-byte base64/);
    expect(() => encryptSecret('x', Buffer.alloc(16), 'k1')).toThrow(/32-byte base64/);
    expect(() =>
      decryptSecret({ ciphertext: 'YQ==', iv: 'YQ==', authTag: 'YQ==' }, Buffer.alloc(16)),
    ).toThrow(/32-byte base64/);
  });
});
