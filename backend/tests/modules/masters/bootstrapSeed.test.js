/**
 * Bootstrap seed integration tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { ApiError } from '../../../src/platform/errors.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ORG_SLUG,
  IDENTITY_MODELS,
  findOrganizationBySlug,
  findUserByEmail,
  runBootstrapSeed,
} from '../../../src/modules/masters/index.js';
import { DEFAULT_ORG_CODE } from '../../../src/modules/masters/organizations.js';
import { Organization } from '../../../src/models/organization.model.js';
import { Role } from '../../../src/models/role.model.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: import('vitest').Mock, debug: import('vitest').Mock, error: import('vitest').Mock }}
 */
function createMockLog() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

describe('runBootstrapSeed', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('creates organization, ADMIN role, and admin user on first seed', async () => {
    const log = createMockLog();
    const result = await runBootstrapSeed(log);
    expect(result.result).toBe('created');
    expect(result.slug).toBe(DEFAULT_ORG_SLUG);
    expect(result.adminRoleCode).toBe('ADMIN');
    expect(result.adminUserStatus).toBe('active');

    const org = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    expect(org).toBeTruthy();
    expect(org.code).toBe(DEFAULT_ORG_CODE);
    const roles = await Role.find({ orgId: org._id }).sort({ name: 1 });
    expect(roles).toHaveLength(1);
    expect(roles[0].code).toBe('ADMIN');
    const admin = await findUserByEmail(org._id, DEFAULT_ADMIN_EMAIL);
    expect(admin).toBeTruthy();
    expect(admin.code).toBe('ADMIN');
    expect(admin.userStatus).toBe('active');
    expect(admin.roleIds).toHaveLength(1);
    expect(admin.projectAccessMode).toBe('all');

    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][1]).toBe('bootstrap seed succeeded');
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain(DEFAULT_ADMIN_EMAIL);
    expect(logged).not.toContain('password');
    expect(logged).not.toContain('abc123');
  });

  it('changes nothing on a second seed and reports already_present', async () => {
    const firstLog = createMockLog();
    const first = await runBootstrapSeed(firstLog);
    const org = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const admin = await findUserByEmail(org._id, DEFAULT_ADMIN_EMAIL);
    const orgUpdatedAt = org.updatedAt.getTime();
    const adminUpdatedAt = admin.updatedAt.getTime();

    const secondLog = createMockLog();
    const second = await runBootstrapSeed(secondLog);
    expect(second.result).toBe('already_present');
    expect(second.orgId).toBe(first.orgId);
    expect(second.adminUserId).toBe(first.adminUserId);

    const orgAgain = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    const adminAgain = await findUserByEmail(org._id, DEFAULT_ADMIN_EMAIL);
    expect(orgAgain.updatedAt.getTime()).toBe(orgUpdatedAt);
    expect(adminAgain.updatedAt.getTime()).toBe(adminUpdatedAt);
    expect(secondLog.info).toHaveBeenCalledTimes(1);
  });

  it('creates exactly one organization when two seeds run concurrently', async () => {
    const results = await Promise.all([runBootstrapSeed(createMockLog()), runBootstrapSeed(createMockLog())]);
    expect(results.every((r) => r.slug === DEFAULT_ORG_SLUG)).toBe(true);
    const orgs = await (await import('../../../src/models/organization.model.js')).Organization.find({ slug: DEFAULT_ORG_SLUG });
    expect(orgs).toHaveLength(1);
  });

  it('emits per-step debug logs when debug is provided', async () => {
    const log = createMockLog();
    await runBootstrapSeed(log);
    expect(log.debug.mock.calls.length).toBeGreaterThan(1);
    expect(log.debug.mock.calls.every((call) => call[1] === 'bootstrap seed step')).toBe(true);
  });

  it('leaves no organization behind when the admin user insert fails', async () => {
    const log = createMockLog();
    const usersRepo = await import('../../../src/modules/masters/users.js');
    const spy = vi.spyOn(usersRepo, 'createUserInRepo').mockRejectedValue(
      ApiError.fromCode('BOOTSTRAP_FAILED', {
        message: 'Administrator user could not be ensured.',
      }),
    );

    await expect(runBootstrapSeed(log)).rejects.toMatchObject({
      code: 'BOOTSTRAP_FAILED',
    });
    expect(log.error).toHaveBeenCalled();
    spy.mockRestore();

    const org = await findOrganizationBySlug(DEFAULT_ORG_SLUG);
    expect(org).toBeNull();
  });

  it('wraps unexpected errors as BOOTSTRAP_FAILED', async () => {
    const log = createMockLog();
    const spy = vi.spyOn(Organization, 'findOne').mockReturnValue({
      session() {
        return this;
      },
      exec: vi.fn().mockRejectedValue(new Error('mongo exploded')),
    });
    await expect(runBootstrapSeed(log)).rejects.toMatchObject({
      code: 'BOOTSTRAP_FAILED',
    });
    expect(log.error).toHaveBeenCalled();
    spy.mockRestore();
  });
});
