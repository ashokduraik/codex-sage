/**
 * Auth route integration tests via app.inject.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH, buildApp } from '../../http/app.js';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { AUTH_MODELS, CSRF_COOKIE_NAME } from './index.js';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_PASSWORD,
  IDENTITY_MODELS,
  findOrganizationBySlug,
  findUserByEmail,
  createUser,
  softDeleteUser,
  updateUserPasswordHash,
  runBootstrapSeed,
} from '../identity/index.js';
import { User } from '../identity/user.model.js';
import { hashPassword } from './passwordHasher.js';
import { REFRESH_COOKIE_NAME, createTokenService } from './tokenService.js';
import { revokeSession } from './session.repository.js';

const harness = createMongoHarness({
  models: [...IDENTITY_MODELS, ...AUTH_MODELS],
  uri: TEST_APP_CONFIG.mongo.uri,
});

/**
 * @returns {{ info: Function, debug: Function, error: Function }}
 */
function createMockLog() {
  return { info: () => {}, debug: () => {}, error: () => {} };
}

/**
 * Builds a Cookie header from an inject response's set-cookie values.
 * @param {import('light-my-request').Response} res Inject response.
 * @param {Record<string, string>} [prior] Prior cookie jar to merge (CSRF secret may not be re-sent).
 * @param {Record<string, string>} [overrides] Cookie overrides.
 */
function cookieJarFromResponse(res, prior = {}, overrides = {}) {
  /** @type {Record<string, string>} */
  const jar = { ...prior };
  const setCookie = res.headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const entry of list) {
    const pair = String(entry).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // Cleared cookies arrive as empty values — drop them from the jar.
      if (value === '') {
        delete jar[name];
      } else {
        jar[name] = value;
      }
    }
  }
  Object.assign(jar, overrides);
  return {
    cookieHeader: Object.entries(jar)
      .map(([name, value]) => `${name}=${value}`)
      .join('; '),
    csrfToken: jar[CSRF_COOKIE_NAME],
    refreshToken: jar[REFRESH_COOKIE_NAME],
    jar,
  };
}

describe('auth.routes', () => {
  /** @type {import('fastify').FastifyInstance | undefined} */
  let app;

  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  /**
   * @returns {Promise<import('fastify').FastifyInstance>}
   */
  async function readyApp() {
    const instance = buildApp(TEST_APP_CONFIG);
    await instance.ready();
    return instance;
  }

  it('logs in the bootstrap admin and serves /me with the access token', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const login = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      payload: { email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.user.email).toBe(DEFAULT_ADMIN_EMAIL);
    expect(body).not.toHaveProperty('refreshToken');

    const me = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(DEFAULT_ADMIN_EMAIL);

    const unauth = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rotates refresh tokens and detects reuse by revoking the family', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const login = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      payload: { email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD },
    });
    const jar1 = cookieJarFromResponse(login);

    const refresh1 = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/refresh`,
      headers: {
        cookie: jar1.cookieHeader,
        'x-csrf-token': jar1.csrfToken,
      },
    });
    expect(refresh1.statusCode).toBe(200);
    const jar2 = cookieJarFromResponse(refresh1, jar1.jar);

    const reuse = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/refresh`,
      headers: {
        cookie: jar1.cookieHeader,
        'x-csrf-token': jar1.csrfToken,
      },
    });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe('SESSION_EXPIRED');

    const newestFails = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/refresh`,
      headers: {
        cookie: jar2.cookieHeader,
        'x-csrf-token': jar2.csrfToken,
      },
    });
    expect(newestFails.statusCode).toBe(401);
    expect(newestFails.json().error.code).toBe('SESSION_EXPIRED');
  });

  it('logout returns 204 and invalidates access via sid check; unknown refresh still 204', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const login = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      payload: { email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD },
    });
    const accessToken = login.json().accessToken;
    const jar = cookieJarFromResponse(login);

    const logout = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/logout`,
      headers: {
        cookie: jar.cookieHeader,
        'x-csrf-token': jar.csrfToken,
      },
    });
    expect(logout.statusCode).toBe(204);

    const me = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('SESSION_EXPIRED');

    const login2 = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      payload: { email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD },
    });
    const jarUnknown = cookieJarFromResponse(login2, {}, {
      [REFRESH_COOKIE_NAME]: 'unknown-refresh-token-value',
    });
    const logoutUnknown = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/logout`,
      headers: {
        cookie: jarUnknown.cookieHeader,
        'x-csrf-token': jarUnknown.csrfToken,
      },
    });
    expect(logoutUnknown.statusCode).toBe(204);
  });

  it('returns identical INVALID_CREDENTIALS for all rejected login cases', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const organization = await findOrganizationBySlug('default');
    const orgId = organization._id;

    await createUser(orgId, {
      email: 'invited@example.com',
      displayName: 'Invited',
      userStatus: 'invited',
    });

    const disabled = await createUser(orgId, {
      email: 'disabled@example.com',
      displayName: 'Disabled',
      userStatus: 'active',
    });
    await updateUserPasswordHash(
      orgId,
      disabled._id,
      await hashPassword('secret-password'),
    );
    await User.updateOne(
      { _id: disabled._id },
      { $set: { userStatus: 'disabled' } },
    );

    const softDeleted = await createUser(orgId, {
      email: 'deleted@example.com',
      displayName: 'Deleted',
      userStatus: 'active',
    });
    await updateUserPasswordHash(
      orgId,
      softDeleted._id,
      await hashPassword('secret-password'),
    );
    await softDeleteUser(orgId, softDeleted._id);

    const cases = [
      { email: 'unknown@example.com', password: 'x' },
      { email: DEFAULT_ADMIN_EMAIL, password: 'wrong-password' },
      { email: 'invited@example.com', password: 'x' },
      { email: 'disabled@example.com', password: 'secret-password' },
      { email: 'deleted@example.com', password: 'secret-password' },
    ];

    /** @type {string[]} */
    const codes = [];
    /** @type {string[]} */
    const messages = [];
    for (const payload of cases) {
      const res = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/login`,
        payload,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
      codes.push(res.json().error.code);
      messages.push(res.json().error.message);
    }
    expect(new Set(codes).size).toBe(1);
    expect(new Set(messages).size).toBe(1);
  });

  it('rejects tokens after passwordUpdatedAt advances and after session revoke', async () => {
    await runBootstrapSeed(createMockLog());
    app = await readyApp();
    const login = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      payload: { email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD },
    });
    const accessToken = login.json().accessToken;
    const organization = await findOrganizationBySlug('default');
    const admin = await findUserByEmail(organization._id, DEFAULT_ADMIN_EMAIL);
    await updateUserPasswordHash(
      admin.orgId,
      admin._id,
      await hashPassword(DEFAULT_ADMIN_PASSWORD),
    );
    // Ensure passwordUpdatedAt is strictly after the token iat (integer seconds).
    await User.updateOne(
      { _id: admin._id },
      { $set: { passwordUpdatedAt: new Date(Date.now() + 2_000) } },
    );

    const meAfterPassword = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meAfterPassword.statusCode).toBe(401);
    expect(meAfterPassword.json().error.code).toBe('SESSION_EXPIRED');

    const login2 = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/login`,
      payload: { email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD },
    });
    const token2 = login2.json().accessToken;
    const claims2 = createTokenService(
      TEST_APP_CONFIG.auth.jwtAccessTokenSecret,
    ).verifyAccessToken(token2);
    await revokeSession(claims2.sid, 'logout');
    const meAfterRevoke = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/auth/me`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(meAfterRevoke.statusCode).toBe(401);
    expect(meAfterRevoke.json().error.code).toBe('SESSION_EXPIRED');
  });
});
