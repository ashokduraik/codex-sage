/**
 * Unit tests for archive binary download.
 */
import { describe, expect, it, vi } from 'vitest';
import { isAllowedArchiveRedirect, outboundDownload } from '../../../src/modules/knowledge/repoSync.js';

/**
 * @param {number} status HTTP status.
 * @param {object} [init] Optional headers/body.
 * @returns {Response}
 */
function jsonResponse(status, init = {}) {
  return new Response(init.body ?? '', {
    status,
    headers: init.headers ?? {},
  });
}

describe('outboundDownload', () => {
  it('allows GitHub zipball redirects to codeload and drops auth on that hop', async () => {
    expect(isAllowedArchiveRedirect('api.github.com', 'api.github.com', 'codeload.github.com')).toBe(
      true,
    );
    expect(isAllowedArchiveRedirect('api.github.com', 'api.github.com', 'evil.example')).toBe(false);

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(302, { headers: { location: 'https://codeload.github.com/acme/app/legacy.zip' } }),
      )
      .mockResolvedValueOnce(new Response(Buffer.from('PK'), { status: 200 }));

    const result = await outboundDownload({
      url: 'https://api.github.com/repos/acme/app/zipball/abc',
      headers: { Authorization: 'Bearer secret-token-never-log' },
      fetchImpl,
      allowPrivateHosts: true,
    });
    expect(result.status).toBe(200);
    expect(result.buffer.toString()).toBe('PK');
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it('maps timeout and size-cap failures', async () => {
    await expect(
      outboundDownload({
        url: 'https://api.github.com/repos/acme/app/zipball/abc',
        fetchImpl: async () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
        allowPrivateHosts: true,
      }),
    ).rejects.toMatchObject({ code: 'PROBE_TIMEOUT' });

    const big = new Uint8Array(16);
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: {
        getReader() {
          return {
            async read() {
              return { done: false, value: big };
            },
            async cancel() {},
          };
        },
      },
    });
    await expect(
      outboundDownload({
        url: 'https://api.github.com/repos/acme/app/zipball/abc',
        fetchImpl,
        maxBytes: 8,
        allowPrivateHosts: true,
      }),
    ).rejects.toMatchObject({ code: 'PROBE_SIZE' });
  });

  it('returns empty buffer for non-200 without following a disallowed redirect', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401));
    const result = await outboundDownload({
      url: 'https://api.github.com/repos/acme/app/zipball/abc',
      fetchImpl,
      allowPrivateHosts: true,
    });
    expect(result.status).toBe(401);
    expect(result.buffer.length).toBe(0);

    await expect(
      outboundDownload({
        url: 'https://api.github.com/repos/acme/app/zipball/abc',
        fetchImpl: async () =>
          jsonResponse(302, { headers: { location: 'https://evil.example/zip' } }),
        allowPrivateHosts: true,
      }),
    ).rejects.toMatchObject({ code: 'PROBE_REDIRECT' });

    await expect(
      outboundDownload({
        url: 'https://api.github.com/repos/acme/app/zipball/abc',
        fetchImpl: async () => {
          throw new Error('ECONNRESET');
        },
        allowPrivateHosts: true,
      }),
    ).rejects.toMatchObject({ code: 'PROBE_NETWORK' });
  });
});
