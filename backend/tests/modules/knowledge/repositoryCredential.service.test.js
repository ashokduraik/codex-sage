/**
 * Encrypt / decrypt / replace nested repository credentials.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { RepositoryConnection } from '../../../src/models/repositoryConnection.model.js';
import { insertConnection } from '../../../src/modules/knowledge/repositories.js';
import {
  decryptConnectionToken,
  replaceEncryptedCredential,
  storeEncryptedCredential,
} from '../../../src/modules/knowledge/repositories.js';

const TOKEN_FIXTURE = 'ghp_probe_token_fixture_never_log';

const harness = createMongoHarness({
  models: [RepositoryConnection],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('repositoryCredential.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  /**
   * @returns {Promise<{
   *   orgId: mongoose.Types.ObjectId,
   *   projectId: mongoose.Types.ObjectId,
   *   connectionId: string,
   *   actor: mongoose.Types.ObjectId,
   * }>}
   */
  async function seedConnection() {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const connection = await insertConnection({
      orgId,
      projectId,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/payments',
      repositoryWebUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
    });
    return {
      orgId,
      projectId,
      connectionId: String(connection._id),
      actor,
    };
  }

  it('stores ciphertext only and decrypts the same plaintext', async () => {
    const seeded = await seedConnection();
    const stored = await storeEncryptedCredential({
      orgId: String(seeded.orgId),
      connectionId: seeded.connectionId,
      accessToken: TOKEN_FIXTURE,
      createdBy: String(seeded.actor),
    });

    expect(stored?.credential?.ciphertext).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(TOKEN_FIXTURE);

    const plain = await decryptConnectionToken(stored.credential);
    expect(plain).toBe(TOKEN_FIXTURE);
  });

  it('throws NOT_FOUND when the credential is missing', async () => {
    await expect(decryptConnectionToken(null)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws CREDENTIAL_DECRYPT_FAILED when ciphertext is tampered', async () => {
    const seeded = await seedConnection();
    const stored = await storeEncryptedCredential({
      orgId: String(seeded.orgId),
      connectionId: seeded.connectionId,
      accessToken: TOKEN_FIXTURE,
      createdBy: String(seeded.actor),
    });
    const tamperedCiphertext = Buffer.from('tampered-ciphertext-bytes').toString('base64');
    await RepositoryConnection.updateOne(
      { _id: seeded.connectionId },
      { $set: { 'credential.ciphertext': tamperedCiphertext } },
    ).exec();

    const tampered = await RepositoryConnection.findById(seeded.connectionId).lean().exec();
    await expect(decryptConnectionToken(tampered.credential)).rejects.toMatchObject({
      code: 'CREDENTIAL_DECRYPT_FAILED',
    });
    expect(stored.credential.ciphertext).toBeTruthy();
  });

  it('overwrites the nested credential on replace', async () => {
    const seeded = await seedConnection();
    const first = await storeEncryptedCredential({
      orgId: String(seeded.orgId),
      connectionId: seeded.connectionId,
      accessToken: TOKEN_FIXTURE,
      createdBy: String(seeded.actor),
    });
    const rotated = await replaceEncryptedCredential({
      orgId: String(seeded.orgId),
      connectionId: seeded.connectionId,
      accessToken: 'ghp_replacement_token_value',
      actorUserId: String(seeded.actor),
    });
    expect(rotated?.credential?.ciphertext).not.toBe(first.credential.ciphertext);

    const row = await RepositoryConnection.findById(seeded.connectionId).lean().exec();
    expect(row.credential.ciphertext).toBe(rotated.credential.ciphertext);

    const nextPlain = await decryptConnectionToken(rotated.credential);
    expect(nextPlain).toBe('ghp_replacement_token_value');
  });
});
