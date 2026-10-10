/**
 * Unit tests for probe orchestration (outbound HTTP mocked via fetch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/platform/config.js', () => ({
  loadConfig: () => ({
    repositories: { allowPrivateHosts: true },
  }),
}));

const fetchMock = vi.fn();

/**
 * Builds a fetch Response-shaped object with a capped JSON body reader.
 * @param {number} status HTTP status.
 * @param {object | unknown[]} body JSON body.
 * @returns {object}
 */
function jsonFetchResponse(status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) {
              return { done: true, value: undefined };
            }
            sent = true;
            return { done: false, value: encoded };
          },
          async cancel() {},
        };
      },
    },
  };
}

const { probeRepository } = await import('../../../src/modules/knowledge/repositories.helper.js');

describe('probeRepository', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns connected with branches for a public GitHub URL', async () => {
    fetchMock.mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('/repos/acme/payments/branches')) {
        return jsonFetchResponse(200, [{ name: 'main' }, { name: 'develop' }]);
      }
      if (href.includes('/repos/acme/payments')) {
        return jsonFetchResponse(200, {
          default_branch: 'main',
          html_url: 'https://github.com/acme/payments',
          private: false,
          description: 'Payments',
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    const result = await probeRepository({
      repositoryUrl: 'https://github.com/acme/payments',
    });
    expect(result.probeStatus).toBe('connected');
    expect(result.branches).toEqual(['main', 'develop']);
    expect(result.tokenUsed).toBe(false);
    expect(result.repository.visibility).toBe('public');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('returns authentication_required with baseUrl for a private self-hosted GitLab URL', async () => {
    fetchMock.mockResolvedValue(jsonFetchResponse(404, { message: '404 Project Not Found' }));

    const result = await probeRepository({
      repositoryUrl: 'https://gitlab.example.com/group/payments',
    });
    expect(result.probeStatus).toBe('authentication_required');
    expect(result.baseUrl).toBe('https://gitlab.example.com');
    expect(result.reason.code).toBe('token_missing');
    expect(result.repository.fullName).toBe('group/payments');
  });

  it('returns connected when a valid token unlocks the repository', async () => {
    let lookupCalls = 0;
    fetchMock.mockImplementation(async (url) => {
      const href = String(url);
      if (href.includes('/repository/branches')) {
        return jsonFetchResponse(200, [{ name: 'main' }]);
      }
      if (href.includes('/api/v4/projects/')) {
        lookupCalls += 1;
        if (lookupCalls === 1) {
          return jsonFetchResponse(404, { message: '404' });
        }
        return jsonFetchResponse(200, {
          default_branch: 'main',
          web_url: 'https://gitlab.com/acme/payments',
          visibility: 'private',
          description: 'Pay',
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    const result = await probeRepository({
      repositoryUrl: 'https://gitlab.com/acme/payments',
      accessToken: 'glpat-valid',
    });
    expect(result.probeStatus).toBe('connected');
    expect(result.tokenUsed).toBe(true);
  });

  it('maps an invalid token to token_invalid and an unscoped token to access_denied', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonFetchResponse(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(jsonFetchResponse(401, { message: 'Bad credentials' }));
    const invalid = await probeRepository({
      repositoryUrl: 'https://github.com/acme/payments',
      accessToken: 'bad',
    });
    expect(invalid.reason.code).toBe('token_invalid');

    fetchMock.mockResolvedValueOnce(jsonFetchResponse(404, {})).mockResolvedValueOnce(jsonFetchResponse(403, {}));
    const denied = await probeRepository({
      repositoryUrl: 'https://github.com/acme/payments',
      accessToken: 'no-scope',
    });
    expect(denied.probeStatus).toBe('access_denied');
  });

  it('maps provider timeout to unreachable without provider text', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const result = await probeRepository({
      repositoryUrl: 'https://github.com/acme/payments',
    });
    expect(result.probeStatus).toBe('unreachable');
    expect(JSON.stringify(result)).not.toContain('api.github.com');
    expect(JSON.stringify(result)).not.toContain('504');
  });

  it('throws VALIDATION_ERROR for a malformed URL and makes no lookup', async () => {
    await expect(
      probeRepository({
        repositoryUrl: 'ftp://github.com/acme/payments',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
