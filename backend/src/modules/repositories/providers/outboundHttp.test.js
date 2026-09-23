/**
 * Unit tests for guarded outbound HTTP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertHostAllowed,
  outboundGet,
  REPO_PROBE_MAX_RESPONSE_BYTES,
} from './outboundHttp.js';

describe('assertHostAllowed', () => {
  it('rejects loopback addresses when private hosts are disallowed', () => {
    expect(() => assertHostAllowed('https://127.0.0.1/x', false)).toThrow(
      expect.objectContaining({ code: 'PROBE_HOST_NOT_ALLOWED' }),
    );
    expect(() => assertHostAllowed('https://localhost/x', false)).toThrow(
      expect.objectContaining({ code: 'PROBE_HOST_NOT_ALLOWED' }),
    );
    expect(() => assertHostAllowed('https://10.0.0.5/x', false)).toThrow(
      expect.objectContaining({ code: 'PROBE_HOST_NOT_ALLOWED' }),
    );
  });

  it('allows loopback when the private-host flag is set', () => {
    expect(() => assertHostAllowed('https://127.0.0.1/x', true)).not.toThrow();
  });
});

describe('outboundGet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborts on timeout', async () => {
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    await expect(
      outboundGet({
        url: 'https://api.github.com/repos/acme/payments',
        timeoutMs: 5,
        allowPrivateHosts: false,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'PROBE_TIMEOUT' });
  });

  it('refuses a cross-host redirect', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 302,
      headers: new Headers({ location: 'https://evil.example/x' }),
      body: null,
    }));
    await expect(
      outboundGet({
        url: 'https://api.github.com/repos/acme/payments',
        allowPrivateHosts: false,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'PROBE_REDIRECT' });
  });

  it('stops at the size cap', async () => {
    const oversized = new Uint8Array(REPO_PROBE_MAX_RESPONSE_BYTES + 10);
    const fetchImpl = vi.fn(async () => ({
      status: 200,
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
              return { done: false, value: oversized };
            },
            async cancel() {},
          };
        },
      },
    }));
    await expect(
      outboundGet({
        url: 'https://api.github.com/repos/acme/payments',
        allowPrivateHosts: false,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'PROBE_SIZE' });
  });

  it('returns parsed JSON for a 200', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) {
                return { done: true };
              }
              sent = true;
              return { done: false, value: Buffer.from('{"ok":true}') };
            },
            async cancel() {},
          };
        },
      },
    }));
    const result = await outboundGet({
      url: 'https://api.github.com/repos/acme/payments',
      allowPrivateHosts: false,
      fetchImpl,
    });
    expect(result.json).toEqual({ ok: true });
  });
});
