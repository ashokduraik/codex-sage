/**
 * Auth service unit/integration tests.
 */
import { createMongoHarness } from '../../mongoHarness.js';
import { AUTH_MODELS } from '../../../src/modules/access/index.js';
import { createAuthService } from '../../../src/modules/access/auth.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_APP_CONFIG, TEST_JWT_ACCESS_TOKEN_SECRET } from '../../appConfig.js';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD, IDENTITY_MODELS, runBootstrapSeed } from '../../../src/modules/masters/index.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('auth.service', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('returns authenticated on valid credentials and invalid_credentials otherwise', async () => {
    await runBootstrapSeed({ info: () => {}, debug: () => {} });
    const auth = createAuthService(TEST_JWT_ACCESS_TOKEN_SECRET);
    const log = { info: vi.fn() };

    const ok = await auth.login({ email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD }, { log });
    expect(ok.outcome).toBe('authenticated');
    expect(ok.accessToken).toBeTruthy();
    expect(ok.refreshToken).toBeTruthy();
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(DEFAULT_ADMIN_PASSWORD);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(ok.accessToken);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(ok.refreshToken);

    const bad = await auth.login({ email: DEFAULT_ADMIN_EMAIL, password: 'nope' }, { log });
    expect(bad.outcome).toBe('invalid_credentials');
    expect(bad.emailHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refresh rotates and logout ends the login', async () => {
    await runBootstrapSeed({ info: () => {}, debug: () => {} });
    const auth = createAuthService(TEST_JWT_ACCESS_TOKEN_SECRET);
    const login = await auth.login({
      email: DEFAULT_ADMIN_EMAIL,
      password: DEFAULT_ADMIN_PASSWORD,
    });
    const refreshed = await auth.refresh(login.refreshToken);
    expect(refreshed.outcome).toBe('authenticated');

    const oldFails = await auth.refresh(login.refreshToken);
    expect(oldFails.outcome).toBe('reuse_detected');

    const login2 = await auth.login({
      email: DEFAULT_ADMIN_EMAIL,
      password: DEFAULT_ADMIN_PASSWORD,
    });
    await auth.logout(login2.refreshToken);
    const afterLogout = await auth.refresh(login2.refreshToken);
    expect(afterLogout.outcome).toBe('reuse_detected');
  });
});
