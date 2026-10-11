/**
 * Probe route integration tests — ACL, validation, and token redaction.
 */
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { JOB_MODELS } from '../../../src/modules/masters/jobs.js';
import { API_BASE_PATH, buildApp } from '../../../src/http/app.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { hashPassword } from '../../../src/modules/access/auth.js';
import { PROJECT_MODELS } from '../../../src/modules/masters/projects.js';
import { nextTestUserCode, ensureTestRoles } from '../../identityFixtures.js';
import { IDEMPOTENCY_MODELS } from '../../../src/platform/idempotency/index.js';
import { addProjectMember } from '../../../src/modules/masters/projectMembers.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_MODELS, listAuditEvents } from '../../../src/modules/access/audit.js';
import { probeRepository } from '../../../src/modules/knowledge/repositories.helper.js';
import { REPOSITORY_MODELS, RepositoryConnection } from '../../../src/modules/knowledge/repositories.js';
import {
  findRoleByCode,
  IDENTITY_MODELS,
  createUserInRepo,
  runBootstrapSeed,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  findOrganizationBySlug,
} from '../../../src/modules/masters/index.js';

vi.mock('../../../src/modules/knowledge/repositories.helper.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    probeRepository: vi.fn(),
  };
});

const TOKEN_FIXTURE = 'ghp_probe_token_fixture_never_log';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS, ...AUDIT_MODELS, ...IDEMPOTENCY_MODELS, ...PROJECT_MODELS, ...REPOSITORY_MODELS, ...JOB_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

describe('repository probe routes', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.clearAllMocks();
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  async function readyApp() {
    const instance = buildApp(TEST_APP_CONFIG);
    await instance.ready();
    return instance;
  }

  async function login(instance, email, password) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function createProject(instance, accessToken, name, key) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': key,
      },
      payload: { name, sourceType: 'repository' },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('returns 200 connected for a public repository without a token', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Probe Public', 'idem-probe-proj-1');
    probeRepository.mockResolvedValue({
      probeStatus: 'connected',
      provider: 'github',
      hostKind: 'github',
      baseUrl: null,
      repository: { fullName: 'acme/payments', visibility: 'public' },
      defaultBranch: 'main',
      branches: ['main'],
      branchesTruncated: false,
      tokenUsed: false,
    });

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/probe`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { repositoryUrl: 'https://github.com/acme/payments' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().probeStatus).toBe('connected');
    expect(JSON.stringify(res.json())).not.toContain(TOKEN_FIXTURE);
  });

  it('returns 200 authentication_required with baseUrl for a private URL', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Probe Private', 'idem-probe-proj-2');
    probeRepository.mockResolvedValue({
      probeStatus: 'authentication_required',
      provider: 'gitlab',
      hostKind: 'gitlab_self_hosted',
      baseUrl: 'https://gitlab.example.com',
      repository: { fullName: 'group/payments' },
      reason: { code: 'token_missing', message: 'This repository looks private or requires authentication.' },
      tokenUsed: false,
    });

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/probe`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { repositoryUrl: 'https://gitlab.example.com/group/payments' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().probeStatus).toBe('authentication_required');
    expect(res.json().baseUrl).toBe('https://gitlab.example.com');
  });

  it('returns 400 when the probe body is missing', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Probe Empty', 'idem-probe-proj-empty');
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/probe`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(probeRepository).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed URL and does not probe', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Probe Bad', 'idem-probe-proj-3');
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/probe`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { repositoryUrl: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(probeRepository).not.toHaveBeenCalled();
  });

  it('returns 403 without repos.connect and 404 for another org project', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken: adminToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, adminToken, 'Probe ACL', 'idem-probe-proj-4');

    await ensureTestRoles(org._id);
    const viewerRole = await findRoleByCode(org._id, 'VIEWER');
    const viewer = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: 'viewer-probe@example.com',
      displayName: 'Viewer Probe',
      passwordHash: await hashPassword('ViewerPass1!'),
      userStatus: 'active',
      createdBy: null,
      roleIds: [viewerRole._id],
    });
    await addProjectMember({
      orgId: String(org._id),
      projectId: project.id,
      userId: String(viewer._id),
      actorUserId: String(viewer._id),
      roleId: String(viewerRole._id),
      correlationId: 'corr-probe-viewer',
      log: createMockLog(),
    });
    const { accessToken: viewerToken } = await login(app, 'viewer-probe@example.com', 'ViewerPass1!');
    const forbidden = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/probe`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { repositoryUrl: 'https://github.com/acme/payments' },
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/000000000000000000000000/repositories/probe`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { repositoryUrl: 'https://github.com/acme/payments' },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('repository attach routes', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.clearAllMocks();
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  async function readyApp() {
    const instance = buildApp(TEST_APP_CONFIG);
    await instance.ready();
    return instance;
  }

  async function login(instance, email, password) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  async function createProject(instance, accessToken, name, key) {
    const res = await instance.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': key,
      },
      payload: { name, sourceType: 'repository' },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  function mockConnectedProbe() {
    probeRepository.mockResolvedValue({
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
    });
  }

  it('attaches after a connected probe and replays the same Idempotency-Key', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Attach One', 'idem-attach-proj-1');
    mockConnectedProbe();

    const headers = {
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': 'idem-attach-repo-1',
    };
    const payload = {
      repositoryUrl: 'https://github.com/acme/payments',
      selectedBranch: 'main',
      accessToken: TOKEN_FIXTURE,
    };
    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().project.lifecycleStatus).toBe('source_received');
    expect(JSON.stringify(first.json())).not.toContain(TOKEN_FIXTURE);

    const replay = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories`,
      headers,
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().connection.id).toBe(first.json().connection.id);
    expect(await RepositoryConnection.countDocuments()).toBe(1);

    const org = await findOrganizationBySlug('default');
    const audits = await listAuditEvents(org._id, { action: 'repository.connected' });
    expect(audits.items.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits.items[0].context)).not.toContain(TOKEN_FIXTURE);
  });

  it('returns 409 CONNECTION_NOT_VERIFIED and does not persist on probe failure', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Attach Fail', 'idem-attach-proj-2');
    probeRepository.mockResolvedValue({
      probeStatus: 'access_denied',
      provider: 'github',
      hostKind: 'github',
      repository: { fullName: 'acme/payments' },
      reason: { code: 'token_insufficient', message: 'denied' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-attach-fail-1',
      },
      payload: {
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
        accessToken: TOKEN_FIXTURE,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONNECTION_NOT_VERIFIED');
    expect(await RepositoryConnection.countDocuments()).toBe(0);
    expect(JSON.stringify(res.json())).not.toContain(TOKEN_FIXTURE);
  });

  it('requires Idempotency-Key on attach and rejects extra body keys', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Attach Valid', 'idem-attach-proj-3');
    const missing = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
      },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const invalid = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-attach-bad-body',
      },
      payload: { repositoryUrl: 'https://github.com/acme/payments' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(probeRepository).not.toHaveBeenCalled();

    const secretInvalid = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-attach-empty-token',
      },
      payload: {
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
        accessToken: '',
      },
    });
    expect(secretInvalid.statusCode).toBe(400);
    expect(JSON.stringify(secretInvalid.json())).not.toContain(TOKEN_FIXTURE);
    const tokenDetail = secretInvalid.json().error.details.find((row) => row.path === 'accessToken');
    expect(tokenDetail?.message).toBe('invalid');
  });

  it('lets a viewer GET connection metadata but not mutate', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken: adminToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const org = await findOrganizationBySlug('default');
    const project = await createProject(app, adminToken, 'Attach ACL', 'idem-attach-proj-4');
    mockConnectedProbe();
    const attached = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'idempotency-key': 'idem-attach-acl-1',
      },
      payload: {
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
        accessToken: TOKEN_FIXTURE,
      },
    });
    expect(attached.statusCode).toBe(201);

    await ensureTestRoles(org._id);
    const viewerRole = await findRoleByCode(org._id, 'VIEWER');
    const viewer = await createUserInRepo(org._id, {
      code: nextTestUserCode(),
      email: 'viewer-attach@example.com',
      displayName: 'Viewer Attach',
      passwordHash: await hashPassword('ViewerPass1!'),
      userStatus: 'active',
      createdBy: null,
      roleIds: [viewerRole._id],
    });
    await addProjectMember({
      orgId: String(org._id),
      projectId: project.id,
      userId: String(viewer._id),
      actorUserId: String(viewer._id),
      roleId: String(viewerRole._id),
      correlationId: 'corr-attach-viewer',
      log: createMockLog(),
    });
    const { accessToken: viewerToken } = await login(app, 'viewer-attach@example.com', 'ViewerPass1!');

    const viewed = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/connection`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(viewed.statusCode).toBe(200);
    expect(viewed.json().connection.selectedBranch).toBe('main');
    expect(JSON.stringify(viewed.json())).not.toContain(TOKEN_FIXTURE);

    const forbidden = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/connection/re-test`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('patches branch, replaces credential, re-tests, and revokes', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Attach Cycle', 'idem-attach-proj-5');
    mockConnectedProbe();
    const auth = { authorization: `Bearer ${accessToken}` };
    await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories`,
      headers: { ...auth, 'idempotency-key': 'idem-attach-cycle-1' },
      payload: {
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
        accessToken: TOKEN_FIXTURE,
      },
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/connection/branch`,
      headers: auth,
      payload: { selectedBranch: 'develop' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().connection.selectedBranch).toBe('develop');

    const replaced = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/credentials/replace`,
      headers: auth,
      payload: { accessToken: 'ghp_replacement_token_value' },
    });
    expect(replaced.statusCode).toBe(200);
    expect(JSON.stringify(replaced.json())).not.toContain('ghp_replacement_token_value');

    const retest = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/connection/re-test`,
      headers: auth,
    });
    expect(retest.statusCode).toBe(200);
    expect(retest.json().connectionStatus).toBe('connected');

    const revoked = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/credentials/revoke`,
      headers: auth,
    });
    expect(revoked.statusCode).toBe(204);

    const missing = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/connection`,
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);

    const badBranch = await app.inject({
      method: 'PATCH',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/connection/branch`,
      headers: auth,
      payload: {},
    });
    expect(badBranch.statusCode).toBe(400);

    const badReplace = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/credentials/replace`,
      headers: auth,
      payload: { accessToken: '' },
    });
    expect(badReplace.statusCode).toBe(400);
    expect(JSON.stringify(badReplace.json())).not.toContain(TOKEN_FIXTURE);
  });

  it('returns 404 for another org project on attach', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/000000000000000000000000/repositories`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-attach-missing',
      },
      payload: {
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('enqueues repo_sync with Idempotency-Key and 404s without a connection', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const { accessToken } = await login(app, DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
    const project = await createProject(app, accessToken, 'Sync Target', 'idem-sync-proj');
    probeRepository.mockResolvedValue({
      probeStatus: 'connected',
      provider: 'github',
      hostKind: 'github',
      baseUrl: null,
      repository: { fullName: 'acme/payments', webUrl: 'https://github.com/acme/payments' },
      defaultBranch: 'main',
      branches: ['main'],
      branchesTruncated: false,
      tokenUsed: false,
    });
    await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-sync-attach',
      },
      payload: {
        repositoryUrl: 'https://github.com/acme/payments',
        selectedBranch: 'main',
      },
    });

    const first = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/sync`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-sync-1',
      },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().job.jobType).toBe('repo_sync');

    const replay = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${project.id}/repositories/sync`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-sync-1',
      },
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().job.id).toBe(first.json().job.id);

    const other = await createProject(app, accessToken, 'No Conn', 'idem-sync-nocon');
    const missing = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/projects/${other.id}/repositories/sync`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-sync-missing',
      },
    });
    expect(missing.statusCode).toBe(404);
  });
});
