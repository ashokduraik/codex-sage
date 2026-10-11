/**
 * Tenant-scoped connection and credential persistence.
 */
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { includeDeleted, ROW_STATUS_DELETED } from '../../../src/platform/data/index.js';
import { RepositoryConnection } from '../../../src/models/repositoryConnection.model.js';
import {
  insertConnection,
  updateConnection,
  listDueConnections,
  findActiveConnection,
  softDeleteConnection,
} from '../../../src/modules/knowledge/repositories.js';

const harness = createMongoHarness({
  models: [RepositoryConnection],
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

  it('lists due connections and hides ones that are not yet due', async () => {
    const { orgId, projectId } = ids();
    await insertConnection({
      orgId,
      projectId,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/due',
      repositoryWebUrl: 'https://github.com/acme/due',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
      nextDueAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const later = ids();
    await insertConnection({
      orgId: later.orgId,
      projectId: later.projectId,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/later',
      repositoryWebUrl: 'https://github.com/acme/later',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
      nextDueAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    const due = await listDueConnections(new Date('2026-01-01T00:00:00.000Z'));
    expect(due.some((row) => row.repositoryFullName === 'acme/due')).toBe(true);
    expect(due.some((row) => row.repositoryFullName === 'acme/later')).toBe(false);
  });

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

  it('updates connection fields and stores a nested credential', async () => {
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
    const updated = await updateConnection({
      orgId,
      connectionId: connection._id,
      set: {
        selectedBranch: 'develop',
        credential: {
          ciphertext: 'cipher',
          iv: 'iv',
          authTag: 'tag',
          keyId: 'k1',
          credentialKind: 'pat',
        },
      },
    });
    expect(updated?.selectedBranch).toBe('develop');
    expect(updated?.credential?.keyId).toBe('k1');
    expect(updated?.credential?.ciphertext).toBe('cipher');
  });

  it('soft-deletes the connection and leaves nested credential on the tombstone', async () => {
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
      credential: {
        ciphertext: 'cipher',
        iv: 'iv',
        authTag: 'tag',
        keyId: 'k1',
        credentialKind: 'pat',
      },
    });

    await softDeleteConnection({
      orgId,
      projectId,
      connectionId: connection._id,
    });
    expect(await findActiveConnection(orgId, projectId)).toBeNull();

    const hidden = await includeDeleted(RepositoryConnection.findOne({ _id: connection._id }))
      .lean()
      .exec();
    expect(hidden?.status).toBe(ROW_STATUS_DELETED);
    expect(hidden?.credential?.ciphertext).toBe('cipher');
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
        await updateConnection(
          {
            orgId,
            connectionId: connection._id,
            set: {
              selectedBranch: 'release',
              credential: {
                ciphertext: 'cipher',
                iv: 'iv',
                authTag: 'tag',
                keyId: 'k1',
                credentialKind: 'pat',
              },
            },
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    const found = await findActiveConnection(orgId, projectId);
    expect(found?.selectedBranch).toBe('release');
    expect(found?.credential?.keyId).toBe('k1');
    expect(String(found?._id)).toBe(String(connectionId));
  });
});
