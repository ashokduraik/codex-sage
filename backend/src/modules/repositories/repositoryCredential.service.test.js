/**
 * Encrypt / decrypt / rotate repository credentials.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { includeDeleted, ROW_STATUS_DELETED } from '../../platform/data/index.js';
import { RepositoryConnection } from './repositoryConnection.model.js';
import { RepositoryCredential } from './repositoryCredential.model.js';
import { insertConnection } from './repositories.repository.js';
import {
  decryptConnectionToken,
  replaceEncryptedCredential,
  storeEncryptedCredential,
} from './repositoryCredential.service.js';

const TOKEN_FIXTURE = 'ghp_probe_token_fixture_never_log';

const harness = createMongoHarness({
  models: [RepositoryConnection, RepositoryCredential],
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
      projectId: String(seeded.projectId),
      connectionId: seeded.connectionId,
      accessToken: TOKEN_FIXTURE,
      createdBy: String(seeded.actor),
    });

    const row = await RepositoryCredential.findById(stored.credentialId).lean().exec();
    expect(row.ciphertext).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(TOKEN_FIXTURE);

    const plain = await decryptConnectionToken({
      orgId: String(seeded.orgId),
      projectId: String(seeded.projectId),
      credentialId: stored.credentialId,
    });
    expect(plain).toBe(TOKEN_FIXTURE);
  });

  it('throws NOT_FOUND when the credential is missing', async () => {
    await expect(
      decryptConnectionToken({
        orgId: String(new mongoose.Types.ObjectId()),
        projectId: String(new mongoose.Types.ObjectId()),
        credentialId: String(new mongoose.Types.ObjectId()),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws CREDENTIAL_DECRYPT_FAILED when ciphertext is tampered', async () => {
    const seeded = await seedConnection();
    const stored = await storeEncryptedCredential({
      orgId: String(seeded.orgId),
      projectId: String(seeded.projectId),
      connectionId: seeded.connectionId,
      accessToken: TOKEN_FIXTURE,
      createdBy: String(seeded.actor),
    });
    await RepositoryCredential.updateOne(
      { _id: stored.credentialId },
      { $set: { ciphertext: Buffer.from('tampered-ciphertext-bytes').toString('base64') } },
    ).exec();

    await expect(
      decryptConnectionToken({
        orgId: String(seeded.orgId),
        projectId: String(seeded.projectId),
        credentialId: stored.credentialId,
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPT_FAILED' });
  });

  it('soft-deletes the previous credential and points the connection at the new row', async () => {
    const seeded = await seedConnection();
    const first = await storeEncryptedCredential({
      orgId: String(seeded.orgId),
      projectId: String(seeded.projectId),
      connectionId: seeded.connectionId,
      accessToken: TOKEN_FIXTURE,
      createdBy: String(seeded.actor),
    });
    const rotated = await replaceEncryptedCredential({
      orgId: String(seeded.orgId),
      projectId: String(seeded.projectId),
      connectionId: seeded.connectionId,
      previousCredentialId: first.credentialId,
      accessToken: 'ghp_replacement_token_value',
      actorUserId: String(seeded.actor),
    });
    expect(rotated.credentialId).not.toBe(first.credentialId);

    const oldRow = await includeDeleted(
      RepositoryCredential.findOne({ _id: first.credentialId }),
    )
      .lean()
      .exec();
    expect(oldRow?.status).toBe(ROW_STATUS_DELETED);

    const nextPlain = await decryptConnectionToken({
      orgId: String(seeded.orgId),
      projectId: String(seeded.projectId),
      credentialId: rotated.credentialId,
    });
    expect(nextPlain).toBe('ghp_replacement_token_value');
  });
});
