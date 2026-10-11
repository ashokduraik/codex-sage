import { API_BASE_URL, setAccessToken } from '@/shared/api/index';
import { listAuditEvents } from '@/features/admin/api/auditApi.js';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';

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
        const key = Object.keys(headerMap).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
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

describe('auditApi', () => {
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

  it('listAuditEvents sends from, to, actor, action, resourceType, cursor, and limit', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: { items: [], pageInfo: { nextCursor: null, hasMore: false } },
      }),
    );

    await listAuditEvents({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-13T00:00:00.000Z',
      actor: '507f1f77bcf86cd799439011',
      action: 'user.create',
      resourceType: 'user',
      cursor: 'cur1',
      limit: 25,
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.startsWith(`${API_BASE_URL}/audit-events?`)).toBe(true);
    expect(url).toContain('from=2026-09-01T00%3A00%3A00.000Z');
    expect(url).toContain('to=2026-09-13T00%3A00%3A00.000Z');
    expect(url).toContain('actor=507f1f77bcf86cd799439011');
    expect(url).toContain('action=user.create');
    expect(url).toContain('resourceType=user');
    expect(url).toContain('cursor=cur1');
    expect(url).toContain('limit=25');
  });

  it('listAuditEvents omits empty filters and cursor on the first page', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 200,
        body: { items: [], pageInfo: { nextCursor: null, hasMore: false } },
      }),
    );

    await listAuditEvents({});

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe(`${API_BASE_URL}/audit-events`);
  });
});
