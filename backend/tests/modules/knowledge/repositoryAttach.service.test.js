/**
 * Attach, branch, credential, and re-test orchestration.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { AUDIT_MODELS, listAuditEvents } from '../../../src/modules/access/audit.js';
import { createProject, findProjectById } from '../../../src/modules/masters/projects.helper.js';
import { Project } from '../../../src/models/projects.model.js';
import { SOURCE_MODELS } from '../../../src/modules/knowledge/sources.js';
import { insertSourceVersion } from '../../../src/modules/knowledge/sources.js';
import { EXCLUSION_RULESET_ID } from '../../../src/modules/knowledge/uploads.js';
import { includeDeleted, ROW_STATUS_DELETED } from '../../../src/platform/data/index.js';
import { RepositoryConnection } from '../../../src/models/repositoryConnection.model.js';
import { insertConnection } from '../../../src/modules/knowledge/repositories.js';
import { REPO_BRANCH_LIST_LIMIT } from '../../../src/modules/knowledge/repositories.helper.js';
import {
  attachRepository,
  getRepositoryConnection,
  mapConnectionToDto,
  patchRepositoryBranch,
  replaceRepositoryCredential,
  retestRepositoryConnection,
  revokeRepositoryCredential,
} from '../../../src/modules/knowledge/repositories.js';

const TOKEN_FIXTURE = 'ghp_probe_token_fixture_never_log';

const harness = createMongoHarness({
  models: [Project, RepositoryConnection, ...AUDIT_MODELS, ...SOURCE_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @param {Partial<object>} [overrides]
 * @returns {object}
 */
function connectedProbe(overrides = {}) {
  return {
    probeStatus: 'connected',
    provider: 'github',
    hostKind: 'github',
    baseUrl: null,
    repository: {
      fullName: 'acme/payments',
      webUrl: 'https://github.com/acme/payments',
      visibility: 'private',
    },
    defaultBranch: 'main',
    branches: ['main', 'develop'],
    branchesTruncated: false,
    tokenUsed: true,
    ...overrides,
  };
}

/**
 * @returns {{ info: Function, debug: Function, error: Function, calls: object[] }}
 */
function createCapturingLog() {
  /** @type {object[]} */
  const calls = [];
  const push = (level) => (obj, msg) => {
    calls.push({ level, obj, msg });
  };
  return {
    info: push('info'),
    debug: push('debug'),
    error: push('error'),
    calls,
  };
}

describe('repositoryAttach.service', () => {
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
   * @param {'connecting_repository' | 'awaiting_source' | 'source_received' | 'archived'} lifecycle
   * @param {'repository' | 'upload'} [sourceType]
   */
  async function seedProject(lifecycle = 'connecting_repository', sourceType = 'repository') {
    const orgId = new mongoose.Types.ObjectId();
    const actor = new mongoose.Types.ObjectId();
    const created = await createProject(orgId, {
      name: 'Attach Target',
      sourceType,
      createdBy: actor,
    });
    created.lifecycleStatus = lifecycle;
    await created.save();
    return { orgId, actor, project: created };
  }

  it('maps connection dates and omits secrets', () => {
    const dto = mapConnectionToDto({
      _id: new mongoose.Types.ObjectId(),
      provider: 'github',
      hostKind: 'github',
      baseUrl: null,
      repositoryFullName: 'acme/payments',
      repositoryWebUrl: 'https://github.com/acme/payments',
      visibility: 'private',
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
    expect(dto.lastSuccessfulProbeAt).toBeNull();
    expect(dto.attachedAt).toBeNull();
    expect(dto).not.toHaveProperty('credential');
    expect(dto).not.toHaveProperty('credentialId');
    expect(dto).not.toHaveProperty('accessToken');
    expect(dto).not.toHaveProperty('ciphertext');
    expect(dto.lastSyncedCommitSha).toBeNull();
    expect(dto.lastSyncedAt).toBeNull();

    const withDates = mapConnectionToDto({
      _id: new mongoose.Types.ObjectId(),
      provider: 'gitlab',
      hostKind: 'gitlab_saas',
      baseUrl: 'https://gitlab.com',
      repositoryFullName: 'acme/app',
      repositoryWebUrl: 'https://gitlab.com/acme/app',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
      lastSuccessfulProbeAt: new Date('2026-01-01T00:00:00.000Z'),
      attachedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(withDates.lastSuccessfulProbeAt).toBe('2026-01-01T00:00:00.000Z');
    expect(withDates.attachedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('attaches after a connected probe, encrypts the token, and writes audit', async () => {
    const { orgId, actor, project } = await seedProject();
    const log = createCapturingLog();
    const result = await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      accessToken: TOKEN_FIXTURE,
      correlationId: 'corr-attach-1',
      log,
      probeRepository: async () => connectedProbe(),
    });

    expect(result.project.lifecycleStatus).toBe('source_received');
    expect(result.connection.connectionStatus).toBe('connected');
    expect(result.connection.repository.fullName).toBe('acme/payments');
    expect(JSON.stringify(result)).not.toContain(TOKEN_FIXTURE);
    expect(JSON.stringify(log.calls)).not.toContain(TOKEN_FIXTURE);

    const stored = await RepositoryConnection.findOne({
      orgId,
      projectId: project._id,
    })
      .lean()
      .exec();
    expect(stored?.credential?.ciphertext).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(TOKEN_FIXTURE);

    const audits = await listAuditEvents(orgId, { action: 'repository.connected' });
    expect(audits.items).toHaveLength(1);
    expect(JSON.stringify(audits.items[0].context)).not.toContain(TOKEN_FIXTURE);
    expect(audits.items[0].context.branch).toBe('main');
  });

  it('allows the default branch when the probe list is truncated', async () => {
    const { orgId, actor, project } = await seedProject();
    const result = await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      probeRepository: async () =>
        connectedProbe({
          branches: ['develop'],
          branchesTruncated: true,
          defaultBranch: 'main',
        }),
    });
    expect(result.connection.selectedBranch).toBe('main');
  });

  it('allows the default branch when the probe list is at the cap', async () => {
    const { orgId, actor, project } = await seedProject();
    const branches = Array.from({ length: REPO_BRANCH_LIST_LIMIT }, (_, i) => `b${i}`);
    const result = await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      probeRepository: async () =>
        connectedProbe({
          branches,
          branchesTruncated: false,
          defaultBranch: 'main',
        }),
    });
    expect(result.connection.selectedBranch).toBe('main');
  });

  it('attaches from awaiting_source without storing a credential', async () => {
    const { orgId, actor, project } = await seedProject('awaiting_source', 'upload');
    const result = await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      probeRepository: async () => connectedProbe({ tokenUsed: false }),
    });
    expect(result.project.lifecycleStatus).toBe('source_received');
    const stored = await RepositoryConnection.findOne({ orgId }).lean().exec();
    expect(stored?.credential).toBeNull();
  });

  it('rejects a branch that is not in the probe result', async () => {
    const { orgId, actor, project } = await seedProject();
    await expect(
      attachRepository({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'missing',
        probeRepository: async () => connectedProbe(),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await RepositoryConnection.countDocuments({ orgId })).toBe(0);
  });

  it('does not persist when the probe is not connected', async () => {
    const { orgId, actor, project } = await seedProject();
    await expect(
      attachRepository({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
        accessToken: TOKEN_FIXTURE,
        probeRepository: async () => ({
          probeStatus: 'access_denied',
          provider: 'github',
          hostKind: 'github',
          repository: { fullName: 'acme/payments' },
          reason: { code: 'token_insufficient', message: 'denied' },
        }),
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_VERIFIED' });
    expect(await RepositoryConnection.countDocuments({ orgId })).toBe(0);
    const reloaded = await findProjectById(orgId, String(project._id));
    expect(reloaded?.lifecycleStatus).toBe('connecting_repository');
  });

  it('rejects attach when the project is missing or in the wrong lifecycle', async () => {
    const { orgId, actor, project } = await seedProject('archived');
    await expect(
      attachRepository({
        orgId: String(orgId),
        projectId: String(new mongoose.Types.ObjectId()),
        actorUserId: String(actor),
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
        probeRepository: async () => connectedProbe(),
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(
      attachRepository({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
        probeRepository: async () => connectedProbe(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('maps a unique-index race to CONFLICT', async () => {
    const { orgId, actor, project } = await seedProject();
    await insertConnection({
      orgId,
      projectId: project._id,
      provider: 'github',
      hostKind: 'github',
      repositoryFullName: 'acme/payments',
      repositoryWebUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      defaultBranchAtAttach: 'main',
      connectionStatus: 'connected',
    });
    await expect(
      attachRepository({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
        findActiveConnection: async () => null,
        probeRepository: async () => connectedProbe(),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rethrows non-duplicate insert failures', async () => {
    const { orgId, actor, project } = await seedProject();
    await expect(
      attachRepository({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
        probeRepository: async () => connectedProbe(),
        insertConnection: async () => {
          throw new Error('disk-full');
        },
      }),
    ).rejects.toThrow('disk-full');
  });

  it('rejects a second active connection on the same project', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      probeRepository: async () => connectedProbe(),
    });
    await expect(
      attachRepository({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
        repositoryUrl: 'https://github.com/acme/other',
        selectedBranch: 'main',
        probeRepository: async () =>
          connectedProbe({
            repository: {
              fullName: 'acme/other',
              webUrl: 'https://github.com/acme/other',
            },
          }),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns 404 when no active connection exists', async () => {
    const { orgId, project } = await seedProject();
    await expect(getRepositoryConnection(String(orgId), String(project._id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('patches the selected branch after a live probe', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      accessToken: TOKEN_FIXTURE,
      probeRepository: async () => connectedProbe(),
    });
    const patched = await patchRepositoryBranch({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      selectedBranch: 'develop',
      probeRepository: async () => connectedProbe(),
    });
    expect(patched.connection.selectedBranch).toBe('develop');
    await expect(
      patchRepositoryBranch({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
        selectedBranch: 'develop',
        probeRepository: async () => connectedProbe(),
        updateConnection: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const audits = await listAuditEvents(orgId, { action: 'repository.branch_changed' });
    expect(audits.items).toHaveLength(1);
  });

  it('updates connectionStatus and throws when a branch probe is not connected', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      probeRepository: async () => connectedProbe(),
    });
    await expect(
      patchRepositoryBranch({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
        selectedBranch: 'develop',
        probeRepository: async () => ({
          probeStatus: 'unreachable',
          reason: { code: 'provider_timeout', message: 'timeout' },
        }),
      }),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_VERIFIED' });
    const current = await getRepositoryConnection(String(orgId), String(project._id));
    expect(current.connection.connectionStatus).toBe('unreachable');
  });

  it('replaces the credential row and records the new connectionStatus', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      accessToken: TOKEN_FIXTURE,
      probeRepository: async () => connectedProbe(),
    });
    const first = await RepositoryConnection.findOne({ orgId }).lean().exec();
    const firstCiphertext = first.credential.ciphertext;
    const replaced = await replaceRepositoryCredential({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      accessToken: 'ghp_new_token_value',
      probeRepository: async () => connectedProbe(),
    });
    expect(replaced.connectionStatus).toBe('connected');
    const after = await RepositoryConnection.findOne({ orgId }).lean().exec();
    expect(after.credential.ciphertext).not.toBe(firstCiphertext);
    expect(JSON.stringify(replaced)).not.toContain('ghp_new_token_value');
  });

  it('keeps a replaced credential when the new token probe is not connected', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      accessToken: TOKEN_FIXTURE,
      probeRepository: async () => connectedProbe(),
    });
    const replaced = await replaceRepositoryCredential({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      accessToken: 'ghp_bad_token_value',
      probeRepository: async () => ({
        probeStatus: 'access_denied',
        reason: { code: 'token_insufficient', message: 'denied' },
      }),
    });
    expect(replaced.connectionStatus).toBe('access_denied');
    await expect(
      replaceRepositoryCredential({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
        accessToken: 'ghp_missing_row_token',
        probeRepository: async () => connectedProbe(),
        updateConnection: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('replaces a credential when the connection had none stored', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      probeRepository: async () => connectedProbe(),
    });
    const replaced = await replaceRepositoryCredential({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      accessToken: 'ghp_first_stored_token',
      probeRepository: async () => connectedProbe(),
    });
    expect(replaced.connectionStatus).toBe('connected');
    const stored = await RepositoryConnection.findOne({ orgId }).lean().exec();
    expect(stored?.credential?.ciphertext).toBeTruthy();
  });

  it('revokes the connection and returns to connecting_repository when no versions exist', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      accessToken: TOKEN_FIXTURE,
      probeRepository: async () => connectedProbe(),
    });
    await revokeRepositoryCredential({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
    });
    const tombstone = await includeDeleted(RepositoryConnection.findOne({ orgId })).lean().exec();
    expect(tombstone?.status).toBe(ROW_STATUS_DELETED);
    expect(tombstone?.credential?.ciphertext).toBeTruthy();
    await expect(getRepositoryConnection(String(orgId), String(project._id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const reloaded = await findProjectById(orgId, String(project._id));
    expect(reloaded?.lifecycleStatus).toBe('connecting_repository');
    expect(reloaded?.sourceConfig.repositoryConnectionId).toBeNull();
    const audits = await listAuditEvents(orgId, { action: 'repository.credential_revoked' });
    expect(audits.items).toHaveLength(1);
  });

  it('revokes without changing lifecycle when a source version remains', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      probeRepository: async () => connectedProbe(),
    });
    await insertSourceVersion({
      orgId: String(orgId),
      projectId: String(project._id),
      sourceVersionId: String(new mongoose.Types.ObjectId()),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: String(actor),
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    });
    await revokeRepositoryCredential({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
    });
    const reloaded = await findProjectById(orgId, String(project._id));
    expect(reloaded?.lifecycleStatus).toBe('source_received');
  });

  it('re-tests without changing lifecycle and returns a failed probe status', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      accessToken: TOKEN_FIXTURE,
      probeRepository: async () => connectedProbe(),
    });
    const failed = await retestRepositoryConnection({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      probeRepository: async () => ({
        probeStatus: 'authentication_required',
        reason: { code: 'token_invalid', message: 'expired' },
      }),
    });
    expect(failed.connectionStatus).toBe('authentication_required');
    expect(failed.reason.code).toBe('token_invalid');
    const reloaded = await findProjectById(orgId, String(project._id));
    expect(reloaded?.lifecycleStatus).toBe('source_received');

    const ok = await retestRepositoryConnection({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      probeRepository: async () => connectedProbe(),
    });
    expect(ok.connectionStatus).toBe('connected');
    expect(ok.reason).toBeUndefined();
  });

  it('surfaces decrypt failure on re-test when ciphertext is tampered', async () => {
    const { orgId, actor, project } = await seedProject();
    await attachRepository({
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      accessToken: TOKEN_FIXTURE,
      probeRepository: async () => connectedProbe(),
    });
    const tamperedCiphertext = Buffer.from('tampered-ciphertext-bytes').toString('base64');
    await RepositoryConnection.updateMany({ orgId }, { $set: { 'credential.ciphertext': tamperedCiphertext } }).exec();
    await expect(
      retestRepositoryConnection({
        orgId: String(orgId),
        projectId: String(project._id),
        actorUserId: String(actor),
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_DECRYPT_FAILED' });
  });

  it('returns NOT_FOUND for mutate routes when no connection exists', async () => {
    const { orgId, actor, project } = await seedProject();
    const scope = {
      orgId: String(orgId),
      projectId: String(project._id),
      actorUserId: String(actor),
    };
    await expect(patchRepositoryBranch({ ...scope, selectedBranch: 'main' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(replaceRepositoryCredential({ ...scope, accessToken: 'tok' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(revokeRepositoryCredential(scope)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(retestRepositoryConnection(scope)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
