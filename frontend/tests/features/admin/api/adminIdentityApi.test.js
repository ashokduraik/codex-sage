import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL, setAccessToken } from '@/shared/api/index';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import {
  activateUser,
  createUser,
  deactivateUser,
  fetchPermissionsCatalog,
  listAllRoles,
  listUsers,
  patchUser,
  removeUser,
  resetUserPassword,
} from '@/features/admin/api/adminIdentityApi.js';

/**
 * Builds a mock fetch Response compatible with apiRequest.
 * @param {object} options Response fields.
 * @returns {object}
 */
function jsonResponse({ status, body, headers = {} }) {
  const headerMap = { ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = Object.keys(headerMap).find(
          (candidate) => candidate.toLowerCase() === name.toLowerCase(),
        );
        return key ? headerMap[key] : null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
    clone() {
      return jsonResponse({ status, body, headers });
    },
  };
}

describe('adminIdentityApi', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    resetRefreshClientForTests();
    setAccessToken('tok');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiSessionForTests();
    resetRefreshClientForTests();
  });

  it('listUsers sends q, userStatus, roleId, cursor, and limit', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: { items: [], pageInfo: { nextCursor: null, hasMore: false } },
      }),
    );

    await listUsers({
      q: 'ab',
      userStatus: 'active',
      roleId: '507f1f77bcf86cd799439011',
      cursor: 'cur1',
      limit: 25,
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith(`${API_BASE_URL}/users?`)).toBe(true);
    expect(url).toContain('q=ab');
    expect(url).toContain('userStatus=active');
    expect(url).toContain('roleId=507f1f77bcf86cd799439011');
    expect(url).toContain('cursor=cur1');
    expect(url).toContain('limit=25');
  });

  it('createUser posts body with Idempotency-Key', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 201,
        body: { id: 'u1', email: 'a@b.co', displayName: 'A', roles: [] },
      }),
    );

    await createUser({
      email: 'a@b.co',
      displayName: 'A',
      roleIds: ['r1'],
      idempotencyKey: 'idem-create-1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/users`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'a@b.co',
          displayName: 'A',
          roleIds: ['r1'],
        }),
        headers: expect.objectContaining({
          'Idempotency-Key': 'idem-create-1',
          Authorization: 'Bearer tok',
        }),
      }),
    );
  });

  it('patchUser sends roleIds for role changes', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 200, body: { id: 'u1', roles: [] } }),
    );

    await patchUser('u1', { roleIds: ['r2', 'r3'] });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE_URL}/users/u1`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ roleIds: ['r2', 'r3'] }),
      }),
    );
  });

  it('activate, deactivate, and remove hit the correct paths', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: 200, body: { id: 'u1' } }))
      .mockResolvedValueOnce(jsonResponse({ status: 200, body: { id: 'u1' } }))
      .mockResolvedValueOnce(jsonResponse({ status: 200, body: { id: 'u1' } }));

    await activateUser('u1');
    await deactivateUser('u1');
    await removeUser('u1');

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/users/u1/activate`);
    expect(fetchMock.mock.calls[1][0]).toBe(`${API_BASE_URL}/users/u1/deactivate`);
    expect(fetchMock.mock.calls[2][0]).toBe(`${API_BASE_URL}/users/u1`);
    expect(fetchMock.mock.calls[2][1].method).toBe('DELETE');
  });

  it('resetUserPassword sends newPassword and never expects it in the response', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: { passwordResetStatus: 'completed', deliveryChannel: 'administrator' },
      }),
    );

    const result = await resetUserPassword('u1', {
      newPassword: 'SuperSecret1!',
      idempotencyKey: 'idem-reset-1',
    });

    expect(result.passwordResetStatus).toBe('completed');
    expect(result).not.toHaveProperty('newPassword');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      newPassword: 'SuperSecret1!',
    });
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBe('idem-reset-1');
  });

  it('listAllRoles follows nextCursor until hasMore is false', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          status: 200,
          body: {
            items: [{ id: 'r1', name: 'Admin', permissions: [] }],
            pageInfo: { nextCursor: 'c2', hasMore: true },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 200,
          body: {
            items: [{ id: 'r2', name: 'Viewer', permissions: [] }],
            pageInfo: { nextCursor: null, hasMore: false },
          },
        }),
      );

    const roles = await listAllRoles({ limit: 100 });

    expect(roles).toHaveLength(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=c2');
  });

  it('fetchPermissionsCatalog requests /permissions', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: { groups: [{ id: 'org', label: 'Organization', permissions: [] }] },
      }),
    );

    const catalog = await fetchPermissionsCatalog();
    expect(catalog.groups[0].id).toBe('org');
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/permissions`);
  });
});
