/**
 * Guarded outbound HTTP for repository probes (timeout, redirects, size, hosts).
 */
import { isIP } from 'node:net';
import { loadConfig } from '../../../platform/config.js';

/** Total budget for one provider call. */
export const REPO_PROBE_TIMEOUT_MS = 10_000;

/** Same-host redirects followed before giving up. */
export const REPO_PROBE_MAX_REDIRECTS = 3;

/** Response body cap (bytes). */
export const REPO_PROBE_MAX_RESPONSE_BYTES = 1_048_576;

/**
 * @typedef {{
 *   status: number,
 *   headers: Headers,
 *   bodyText: string,
 *   json: object | null,
 * }} OutboundResponse
 */

/**
 * Performs a GET with timeout, same-host redirect limit, size cap, and host guards.
 * @param {{
 *   url: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   allowPrivateHosts?: boolean,
 *   fetchImpl?: typeof fetch,
 * }} input Request.
 * @returns {Promise<OutboundResponse>}
 */
export async function outboundGet(input) {
  const timeoutMs = input.timeoutMs ?? REPO_PROBE_TIMEOUT_MS;
  const allowPrivateHosts =
    input.allowPrivateHosts ?? loadConfig().repositories.allowPrivateHosts;
  const fetchImpl = input.fetchImpl ?? fetch;
  let currentUrl = input.url;
  let redirects = 0;

  for (;;) {
    assertHostAllowed(currentUrl, allowPrivateHosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        headers: input.headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (err && typeof err === 'object' && err.name === 'AbortError') {
        throw Object.assign(new Error('Repository probe timed out.'), {
          code: 'PROBE_TIMEOUT',
        });
      }
      throw Object.assign(new Error('Repository host could not be reached.'), {
        code: 'PROBE_NETWORK',
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects >= REPO_PROBE_MAX_REDIRECTS) {
        throw Object.assign(new Error('Repository probe exceeded redirect limit.'), {
          code: 'PROBE_REDIRECT',
        });
      }
      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.host !== new URL(currentUrl).host) {
        throw Object.assign(new Error('Repository probe refused a cross-host redirect.'), {
          code: 'PROBE_REDIRECT',
        });
      }
      currentUrl = nextUrl.toString();
      redirects += 1;
      continue;
    }

    const bodyText = await readBodyCapped(response);
    let json = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json') && bodyText) {
      try {
        json = JSON.parse(bodyText);
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      bodyText,
      json,
    };
  }
}

/**
 * Reads a response body up to the size cap.
 * @param {Response} response Fetch response.
 * @returns {Promise<string>}
 */
async function readBodyCapped(response) {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > REPO_PROBE_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw Object.assign(new Error('Repository probe response exceeded the size cap.'), {
        code: 'PROBE_SIZE',
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((part) => Buffer.from(part))).toString('utf8');
}

/**
 * @param {number} status HTTP status.
 * @returns {boolean}
 */
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Rejects loopback, link-local, and private hosts unless allowed.
 * @param {string} rawUrl URL to check.
 * @param {boolean} allowPrivateHosts Dev override.
 */
export function assertHostAllowed(rawUrl, allowPrivateHosts) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('Repository host is not allowed.'), {
      code: 'PROBE_HOST_NOT_ALLOWED',
    });
  }
  const host = url.hostname.toLowerCase();
  if (allowPrivateHosts) {
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    throw Object.assign(new Error('Repository host is not allowed.'), {
      code: 'PROBE_HOST_NOT_ALLOWED',
    });
  }
  const ipVersion = isIP(host);
  if (ipVersion && isPrivateOrLocalIp(host)) {
    throw Object.assign(new Error('Repository host is not allowed.'), {
      code: 'PROBE_HOST_NOT_ALLOWED',
    });
  }
}

/**
 * @param {string} ip Literal IPv4 or IPv6 address.
 * @returns {boolean}
 */
function isPrivateOrLocalIp(ip) {
  if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }
  const ipv4 = ip.includes('.') ? ip : '';
  if (!ipv4) {
    return false;
  }
  const parts = ipv4.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return false;
}
