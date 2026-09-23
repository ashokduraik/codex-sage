/**
 * Tenant-scoped connection and credential persistence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { includeDeleted, ROW_STATUS_DELETED } from '../../platform/data/index.js';
import { RepositoryConnection } from './repositoryConnection.model.js';
import { RepositoryCredential } from './repositoryCredential.model.js';
import {
  findActiveConnection,
  findActiveCredential,
  insertConnection,
  insertCredential,
  softDeleteConnectionAndCredentials,
  softDeleteCredential,
  updateConnection,
} from './repositories.repository.js';

const harness = createMongoHarness({
  models: [RepositoryConnection, RepositoryCredential],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('repositories.repository', () => {
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
   * @returns {{ orgId: mongoose.Types.ObjectId, projectId: mongoose.Types.ObjectId }}
   */
  function ids() {
    return {
      orgId: new mongoose.Types.ObjectId(),
      projectId: new mongoose.Types.ObjectId(),
    };
  }

  it('inserts a connection and finds it only for the owning org and project', async () => {
    const { orgId, projectId } = ids();
    const otherOrg = new mongoose.Types.ObjectId();
    await insertConnection({
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

    const found = await findActiveConnection(orgId, projectId);
    expect(found?.repositoryFullName).toBe('acme/payments');
    expect(await findActiveConnection(otherOrg, projectId)).toBeNull();
    expect(await findActiveConnection(orgId, new mongoose.Types.ObjectId())).toBeNull();
    expect(await findActiveConnection(orgId, 'not-an-id')).toBeNull();
  });

  it('rejects a second active connection for the same project', async () => {
    const { orgId, projectId } = ids();
    await insertConnection({
      orgId,
      projectId,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/one',
      repositoryWebUrl: 'https://github.com/acme/one',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
    });
    await expect(
      insertConnection({
        orgId,
        projectId,
        provider: 'github',
        hostKind: 'github',
        repositoryFullName: 'acme/two',
        repositoryWebUrl: 'https://github.com/acme/two',
        selectedBranch: 'main',
        defaultBranchAtAttach: 'main',
        connectionStatus: 'connected',
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('updates connection fields and stores a credential', async () => {
    const { orgId, projectId } = ids();
    const connection = await insertConnection({
      orgId,
      projectId,
      provider: 'gitlab',
      hostKind: 'gitlab_saas',
      repositoryFullName: 'group/app',
      repositoryWebUrl: 'https://gitlab.com/group/app',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
    });
    const credential = await insertCredential({
      orgId,
      projectId,
      connectionId: connection._id,
      ciphertext: 'cipher',
      iv: 'iv',
      authTag: 'tag',
      keyId: 'k1',
      credentialKind: 'pat',
    });
    const updated = await updateConnection({
      orgId,
      connectionId: connection._id,
      set: { credentialId: credential._id, selectedBranch: 'develop' },
    });
    expect(updated?.selectedBranch).toBe('develop');
    expect(String(updated?.credentialId)).toBe(String(credential._id));

    const found = await findActiveCredential({
      orgId,
      projectId,
      credentialId: credential._id,
    });
    expect(found?.keyId).toBe('k1');
    expect(
      await findActiveCredential({
        orgId,
        projectId,
        credentialId: 'not-an-id',
      }),
    ).toBeNull();
  });

  it('soft-deletes the connection and credentials so get no longer returns them', async () => {
    const { orgId, projectId } = ids();
    const connection = await insertConnection({
      orgId,
      projectId,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/gone',
      repositoryWebUrl: 'https://github.com/acme/gone',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
    });
    const credential = await insertCredential({
      orgId,
      projectId,
      connectionId: connection._id,
      ciphertext: 'cipher',
      iv: 'iv',
      authTag: 'tag',
      keyId: 'k1',
    });

    await softDeleteConnectionAndCredentials({
      orgId,
      projectId,
      connectionId: connection._id,
    });
    expect(await findActiveConnection(orgId, projectId)).toBeNull();
    expect(
      await findActiveCredential({
        orgId,
        projectId,
        credentialId: credential._id,
      }),
    ).toBeNull();

    const hidden = await includeDeleted(RepositoryConnection.findOne({ _id: connection._id }))
      .lean()
      .exec();
    expect(hidden?.status).toBe(ROW_STATUS_DELETED);
  });

  it('saves and updates inside a Mongo session', async () => {
    const { orgId, projectId } = ids();
    const session = await mongoose.startSession();
    let connectionId;
    try {
      await session.withTransaction(async () => {
        const connection = await insertConnection(
          {
            orgId,
            projectId,
            provider: 'github',
            hostKind: 'github',
            repositoryFullName: 'acme/session',
            repositoryWebUrl: 'https://github.com/acme/session',
            selectedBranch: 'main',
            defaultBranchAtAttach: 'main',
            connectionStatus: 'connected',
          },
          { session },
        );
        connectionId = connection._id;
        await insertCredential(
          {
            orgId,
            projectId,
            connectionId: connection._id,
            ciphertext: 'cipher',
            iv: 'iv',
            authTag: 'tag',
            keyId: 'k1',
          },
          { session },
        );
        await updateConnection(
          {
            orgId,
            connectionId: connection._id,
            set: { selectedBranch: 'release' },
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    const found = await findActiveConnection(orgId, projectId);
    expect(found?.selectedBranch).toBe('release');
    expect(String(found?._id)).toBe(String(connectionId));
  });

  it('soft-deletes a single credential row', async () => {
    const { orgId, projectId } = ids();
    const connection = await insertConnection({
      orgId,
      projectId,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/rotate',
      repositoryWebUrl: 'https://github.com/acme/rotate',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
    });
    const credential = await insertCredential({
      orgId,
      projectId,
      connectionId: connection._id,
      ciphertext: 'cipher',
      iv: 'iv',
      authTag: 'tag',
      keyId: 'k1',
    });
    await softDeleteCredential({ orgId, credentialId: credential._id });
    expect(
      await findActiveCredential({
        orgId,
        projectId,
        credentialId: credential._id,
      }),
    ).toBeNull();
  });
});
