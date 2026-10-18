/**
 * Organization usage HTTP client tests.
 */
import { API_BASE_URL, setAccessToken } from '@/shared/api/index';
import { resetApiSessionForTests } from '@/shared/api/apiSession.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import { fetchOrganizationUsage, organizationUsageQueryKey } from '@/features/admin/api/usageApi.js';

/**
 * @param {{ status: number, body: object }} options Response.
 * @returns {object}
 */
function jsonResponse({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
    clone() {
      return jsonResponse({ status, body });
    },
  };
}

describe('usageApi', () => {
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

  it('loads organization usage with optional from/to', async () => {
    const fetchMock = /** @type {ReturnType<typeof vi.fn>} */ (fetch);
    const body = {
      period: { from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' },
      totals: { ingestJobsCompleted: 2, sourceBytesAccepted: 10, searchesExecuted: 4 },
      byProject: [],
      byUser: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body }));
    await expect(fetchOrganizationUsage({ from: '2026-08-27T00:00:00.000Z', to: '2026-09-26T00:00:00.000Z' })).resolves.toEqual(body);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${API_BASE_URL}/masters/projectActivities/getOrganizationUsage?from=2026-08-27T00%3A00%3A00.000Z&to=2026-09-26T00%3A00%3A00.000Z`,
    );
    expect(organizationUsageQueryKey({ from: 'a', to: 'b' })).toEqual(['usage', 'organization', 'a', 'b']);
  });
});
