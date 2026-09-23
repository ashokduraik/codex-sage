/**
 * Binary outbound GET for repository archives (timeout, redirects, size cap).
 */
import { loadConfig } from '../../../platform/config.js';
import { UPLOAD_MAX_ARCHIVE_BYTES } from '../../sources/index.js';
import { assertHostAllowed } from '../providers/outboundHttp.js';
import {
  GITHUB_ARCHIVE_REDIRECT_HOSTS,
  REPO_SYNC_FETCH_TIMEOUT_MS,
} from './repoSync.constants.js';

const MAX_REDIRECTS = 5;

/**
 * @typedef {{
 *   status: number,
 *   headers: Headers,
 *   buffer: Buffer,
 * }} OutboundDownloadResponse
 */

/**
 * Downloads a binary body with host guards and an archive size cap.
 * GitHub zipball may redirect to `codeload.github.com`; auth headers are dropped
 * on that cross-host hop.
 * @param {{
 *   url: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   allowPrivateHosts?: boolean,
 *   fetchImpl?: typeof fetch,
 * }} input Request.
 * @returns {Promise<OutboundDownloadResponse>}
 */
export async function outboundDownload(input) {
  const timeoutMs = input.timeoutMs ?? REPO_SYNC_FETCH_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? UPLOAD_MAX_ARCHIVE_BYTES;
  const allowPrivateHosts =
    input.allowPrivateHosts ?? loadConfig().repositories.allowPrivateHosts;
  const fetchImpl = input.fetchImpl ?? fetch;
  const startHost = new URL(input.url).host;
  let currentUrl = input.url;
  /** @type {Record<string, string> | undefined} */
  let currentHeaders = input.headers;
  let redirects = 0;

  for (;;) {
    assertHostAllowed(currentUrl, allowPrivateHosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        headers: currentHeaders,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if (err && typeof err === 'object' && err.name === 'AbortError') {
        throw Object.assign(new Error('Repository archive download timed out.'), {
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
      if (!location || redirects >= MAX_REDIRECTS) {
        throw Object.assign(new Error('Repository archive exceeded redirect limit.'), {
          code: 'PROBE_REDIRECT',
        });
      }
      const nextUrl = new URL(location, currentUrl);
      if (!isAllowedArchiveRedirect(startHost, new URL(currentUrl).host, nextUrl.host)) {
        throw Object.assign(new Error('Repository archive refused a cross-host redirect.'), {
          code: 'PROBE_REDIRECT',
        });
      }
      if (nextUrl.host !== startHost) {
        currentHeaders = { 'User-Agent': 'codex-sage' };
      }
      currentUrl = nextUrl.toString();
      redirects += 1;
      continue;
    }

    if (response.status !== 200) {
      return {
        status: response.status,
        headers: response.headers,
        buffer: Buffer.alloc(0),
      };
    }

    const buffer = await readBinaryCapped(response, maxBytes);
    return {
      status: response.status,
      headers: response.headers,
      buffer,
    };
  }
}

/**
 * @param {string} startHost Original request host.
 * @param {string} currentHost Host of the last request.
 * @param {string} nextHost Redirect target host.
 * @returns {boolean}
 */
export function isAllowedArchiveRedirect(startHost, currentHost, nextHost) {
  if (nextHost === currentHost) {
    return true;
  }
  return startHost === 'api.github.com' && GITHUB_ARCHIVE_REDIRECT_HOSTS.includes(nextHost);
}

/**
 * @param {number} status HTTP status.
 * @returns {boolean}
 */
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Reads a response body up to maxBytes.
 * @param {Response} response Fetch response.
 * @param {number} maxBytes Size cap.
 * @returns {Promise<Buffer>}
 */
async function readBinaryCapped(response, maxBytes) {
  if (!response.body) {
    return Buffer.alloc(0);
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
    if (received > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error('Repository archive exceeded the size cap.'), {
        code: 'PROBE_SIZE',
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((part) => Buffer.from(part)));
}
