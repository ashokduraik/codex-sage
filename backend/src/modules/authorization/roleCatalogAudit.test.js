import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { IDENTITY_MODELS, createOrganization } from '../identity/index.js';
import { Role } from '../identity/role.model.js';
import { assertRolePermissionsInCatalog } from './roleCatalogAudit.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('roleCatalogAudit', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('passes when every stored permission is in the catalog', async () => {
    const org = await createOrganization({ name: 'Acme', slug: `acme-${Date.now()}` });
    await Role.create({
      orgId: org._id,
      name: 'Ok',
      permissions: ['org.view'],
      isBuiltIn: false,
    });
    await expect(assertRolePermissionsInCatalog()).resolves.toBeUndefined();
  });

  it('fails when a role stores an unknown permission', async () => {
    const org = await createOrganization({ name: 'Acme', slug: `acme-${Date.now()}` });
    await Role.create({
      orgId: org._id,
      name: 'Bad',
      permissions: ['totally.unknown'],
      isBuiltIn: false,
    });
    await expect(assertRolePermissionsInCatalog()).rejects.toThrow(/catalog drift/);
  });
});
