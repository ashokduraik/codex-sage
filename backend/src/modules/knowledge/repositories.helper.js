/**
 * knowledge/repositories.helper.js — merged resource file.
 */
import { loadConfig } from '../../platform/config.js';
import { ApiError } from '../../platform/errors.js';
import { isIP } from 'node:net';

// --- from repositories/providers/outboundHttp.js ---
/**
 * Guarded outbound HTTP for repository probes (timeout, redirects, size, hosts).
 */
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

// --- from repositories/providers/probeErrorMap.js ---
/**
 * Maps provider HTTP / transport failures to probeStatus + reason codes.
 */
const USER_MESSAGES = Object.freeze({
  token_missing: 'This repository looks private or requires authentication.',
  token_invalid: 'The access token was rejected. Check the token and try again.',
  insufficient_scope: 'This token does not have access to the repository.',
  repository_not_found: 'The repository could not be found.',
  network_unreachable: 'The repository host could not be reached.',
  provider_unavailable: 'The repository provider is temporarily unavailable.',
  provider_rate_limited: 'The repository provider rate-limited this request. Try again later.',
  provider_not_supported: 'This host does not look like a supported GitLab instance.',
  host_not_allowed: 'This repository host is not allowed.',
});
/**
 * @typedef {{
 *   probeStatus: 'authentication_required' | 'access_denied' | 'not_found' | 'unreachable',
 *   reason: { code: string, message: string },
 * }} MappedProbeError
 */
// --- from repositories/providers/providerResolver.js ---
/**
 * Infer GitHub / GitLab identity from a repository URL (no provider picker).
 */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const GITLAB_SAAS_HOSTS = new Set(['gitlab.com', 'www.gitlab.com']);
/**
 * @typedef {{
 *   provider: 'github' | 'gitlab',
 *   hostKind: 'github' | 'gitlab_saas' | 'gitlab_self_hosted',
 *   baseUrl: string | null,
 *   ownerPath: string,
 *   repoSlug: string,
 *   fullName: string,
 *   webUrl: string,
 * }} ResolvedRepository
 */
// --- from repositories/providers/githubProbe.js ---
/**
 * GitHub REST calls for repository probe (lookup, branches, optional README).
 */
export const REPO_BRANCH_LIST_LIMIT = 200;
export const REPO_README_MAX_BYTES = 65_536;
const BRANCH_PAGE_SIZE = 100;
// --- from repositories/providers/gitlabProbe.js ---
/**
 * GitLab REST calls for SaaS and self-hosted repository probes.
 */
// --- from repositories/repositoryProbe.service.js ---
/**
 * Stateless repository probe orchestration (Phase 30).
 */

/**
 * Performs a GET with timeout, same-host redirect limit, size cap, and host guards.
 * @param {{
 *   url: string,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   allowPrivateHosts?: boolean,
 * }} input Request.
 * @returns {Promise<OutboundResponse>}
 */
export async function outboundGet(input) {
  const timeoutMs = input.timeoutMs ?? REPO_PROBE_TIMEOUT_MS;
  const allowPrivateHosts = input.allowPrivateHosts ?? loadConfig().repositories.allowPrivateHosts;
  let currentUrl = input.url;
  let redirects = 0;

  for (;;) {
    assertHostAllowed(currentUrl, allowPrivateHosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(currentUrl, {
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

    if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
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
}

/**
 * Maps an anonymous lookup failure.
 * @param {number} status Provider HTTP status.
 * @returns {MappedProbeError}
 */
export function mapAnonymousLookupStatus(status) {
  if (status === 401 || status === 403 || status === 404) {
    return mapped('authentication_required', 'token_missing');
  }
  return mapTransportOrUnexpected(status);
}

/**
 * Maps an authenticated lookup failure.
 * @param {number} status Provider HTTP status.
 * @returns {MappedProbeError}
 */
export function mapAuthenticatedLookupStatus(status) {
  if (status === 401) {
    return mapped('authentication_required', 'token_invalid');
  }
  if (status === 403) {
    return mapped('access_denied', 'insufficient_scope');
  }
  if (status === 404) {
    return mapped('not_found', 'repository_not_found');
  }
  return mapTransportOrUnexpected(status);
}

/**
 * Maps a thrown outbound error (timeout, host, network).
 * @param {unknown} err Thrown value.
 * @returns {MappedProbeError}
 */
export function mapOutboundThrown(err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(/** @type {{ code?: unknown }} */ (err).code) : '';
  if (code === 'PROBE_HOST_NOT_ALLOWED') {
    return mapped('unreachable', 'host_not_allowed');
  }
  if (code === 'PROBE_TIMEOUT' || code === 'PROBE_NETWORK' || code === 'PROBE_REDIRECT') {
    return mapped('unreachable', 'network_unreachable');
  }
  if (code === 'PROBE_SIZE') {
    return mapped('unreachable', 'provider_unavailable');
  }
  return mapped('unreachable', 'provider_unavailable');
}

/**
 * Maps a non-success status that is not an auth/not-found case.
 * @param {number} status HTTP status.
 * @returns {MappedProbeError}
 */
export function mapTransportOrUnexpected(status) {
  if (status === 429) {
    return mapped('unreachable', 'provider_rate_limited');
  }
  if (status >= 500) {
    return mapped('unreachable', 'provider_unavailable');
  }
  return mapped('unreachable', 'provider_unavailable');
}

/**
 * Normalizes a user-supplied repository URL into provider + path parts.
 * @param {string} rawUrl Raw URL from the request body.
 * @returns {ResolvedRepository}
 * @throws {{ code: 'VALIDATION_ERROR', message: string }}
 */
export function resolveRepositoryUrl(rawUrl) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) {
    throw Object.assign(new Error('repositoryUrl is required.'), {
      code: 'VALIDATION_ERROR',
    });
  }

  let parsed;
  try {
    parsed = parseRepositoryInput(trimmed);
  } catch (err) {
    throw Object.assign(new Error('repositoryUrl is not a supported repository URL.'), {
      code: 'VALIDATION_ERROR',
      cause: err,
    });
  }

  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('repositoryUrl must not include credentials.'), {
      code: 'VALIDATION_ERROR',
    });
  }

  const host = parsed.hostname.toLowerCase();
  const fullName = normalizeOwnerRepoPath(parsed.pathname);
  if (!fullName) {
    throw Object.assign(new Error('repositoryUrl must include owner and repository.'), {
      code: 'VALIDATION_ERROR',
    });
  }
  const segments = fullName.split('/');
  const repoSlug = segments[segments.length - 1];
  const ownerPath = segments.slice(0, -1).join('/');

  if (GITHUB_HOSTS.has(host)) {
    if (segments.length !== 2) {
      throw Object.assign(new Error('repositoryUrl must include owner and repository.'), {
        code: 'VALIDATION_ERROR',
      });
    }
    return {
      provider: 'github',
      hostKind: 'github',
      baseUrl: null,
      ownerPath,
      repoSlug,
      fullName,
      webUrl: `https://github.com/${fullName}`,
    };
  }

  if (GITLAB_SAAS_HOSTS.has(host)) {
    return {
      provider: 'gitlab',
      hostKind: 'gitlab_saas',
      baseUrl: null,
      ownerPath,
      repoSlug,
      fullName,
      webUrl: `https://gitlab.com/${fullName}`,
    };
  }

  return {
    provider: 'gitlab',
    hostKind: 'gitlab_self_hosted',
    baseUrl: `https://${host}${parsed.port ? `:${parsed.port}` : ''}`,
    ownerPath,
    repoSlug,
    fullName,
    webUrl: `https://${host}${parsed.port ? `:${parsed.port}` : ''}/${fullName}`,
  };

  /**
   * Parses HTTPS or SSH-style git URLs into a WHATWG URL.
   * @param {string} raw Trimmed input.
   * @returns {URL}
   */
  function parseRepositoryInput(raw) {
    const sshMatch = raw.match(/^git@([^:]+):(.+)$/i);
    if (sshMatch) {
      const host = sshMatch[1];
      const pathPart = sshMatch[2].replace(/\.git$/i, '');
      return new URL(`https://${host}/${pathPart}`);
    }

    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('unsupported scheme');
    }
    return url;
  }

  /**
   * Strips .git / trailing slashes and returns owner[/group]/repo.
   * @param {string} pathname URL pathname.
   * @returns {string}
   */
  function normalizeOwnerRepoPath(pathname) {
    const cleaned = pathname
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
    if (!cleaned || cleaned.includes('..')) {
      return '';
    }
    const segments = cleaned.split('/').filter(Boolean);
    if (segments.length < 2) {
      return '';
    }
    return segments.join('/');
  }
}

/**
 * Looks up a GitHub repository.
 * @param {{
 *   ownerPath: string,
 *   repoSlug: string,
 *   accessToken?: string | null,
 *   outboundGet?: typeof outboundGet,
 * }} input Lookup inputs.
 * @returns {Promise<import('./outboundHttp.js').OutboundResponse>}
 */
export async function lookupGithubRepository(input) {
  const get = input.outboundGet ?? outboundGet;
  return get({
    url: `https://api.github.com/repos/${encodeURIComponent(input.ownerPath)}/${encodeURIComponent(input.repoSlug)}`,
    headers: githubHeaders(input.accessToken),
  });
}

/**
 * Lists branches up to the cap, always including the default branch.
 * @param {{
 *   ownerPath: string,
 *   repoSlug: string,
 *   defaultBranch: string,
 *   accessToken?: string | null,
 *   outboundGet?: typeof outboundGet,
 *   limit?: number,
 * }} input Branch inputs.
 * @returns {Promise<{ branches: string[], branchesTruncated: boolean }>}
 */
export async function listGithubBranches(input) {
  const get = input.outboundGet ?? outboundGet;
  const limit = input.limit ?? REPO_BRANCH_LIST_LIMIT;
  /** @type {string[]} */
  const branches = [];
  let page = 1;
  let truncated = false;

  const pageSize = Math.min(BRANCH_PAGE_SIZE, limit);
  while (branches.length < limit) {
    const response = await get({
      url:
        `https://api.github.com/repos/${encodeURIComponent(input.ownerPath)}/` +
        `${encodeURIComponent(input.repoSlug)}/branches?per_page=${pageSize}&page=${page}`,
      headers: githubHeaders(input.accessToken),
    });
    if (response.status !== 200 || !Array.isArray(response.json)) {
      break;
    }
    for (const row of response.json) {
      if (row && typeof row.name === 'string' && !branches.includes(row.name)) {
        branches.push(row.name);
      }
    }
    if (response.json.length < pageSize) {
      break;
    }
    if (branches.length >= limit) {
      truncated = true;
      break;
    }
    page += 1;
  }

  if (input.defaultBranch && !branches.includes(input.defaultBranch)) {
    branches.unshift(input.defaultBranch);
  }
  const capped = branches.slice(0, limit);
  return {
    branches: capped,
    branchesTruncated: truncated || branches.length > limit,
  };
}

/**
 * Best-effort description from the repo payload or a bounded README.
 * @param {{
 *   ownerPath: string,
 *   repoSlug: string,
 *   accessToken?: string | null,
 *   providerDescription?: string | null,
 *   outboundGet?: typeof outboundGet,
 * }} input Readme inputs.
 * @returns {Promise<string | null>}
 */
export async function readGithubDescription(input) {
  if (typeof input.providerDescription === 'string' && input.providerDescription.trim()) {
    return input.providerDescription.trim();
  }
  try {
    const get = input.outboundGet ?? outboundGet;
    const response = await get({
      url: `https://api.github.com/repos/${encodeURIComponent(input.ownerPath)}/` + `${encodeURIComponent(input.repoSlug)}/readme`,
      headers: githubHeaders(input.accessToken),
    });
    if (response.status !== 200 || !response.json || typeof response.json.content !== 'string') {
      return null;
    }
    const decoded = Buffer.from(response.json.content, 'base64').toString('utf8');
    return firstReadmeParagraph(decoded);
  } catch {
    return null;
  }
}

/**
 * @param {string | null | undefined} accessToken Token.
 * @returns {Record<string, string>}
 */
export function githubHeaders(accessToken) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'codex-sage',
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

/**
 * First non-heading paragraph of a README, or null.
 * @param {string} markdown Readme text.
 * @returns {string | null}
 */
export function firstReadmeParagraph(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return null;
  }
  const bounded = markdown.slice(0, REPO_README_MAX_BYTES);
  const blocks = bounded.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    return trimmed.replace(/\s+/g, ' ').slice(0, 400);
  }
  return null;
}

/**
 * Looks up a GitLab project (SaaS or self-hosted).
 * @param {{
 *   baseUrl: string | null,
 *   fullName: string,
 *   accessToken?: string | null,
 *   outboundGet?: typeof outboundGet,
 * }} input Lookup inputs.
 * @returns {Promise<import('./outboundHttp.js').OutboundResponse>}
 */
export async function lookupGitlabProject(input) {
  const get = input.outboundGet ?? outboundGet;
  const apiBase = gitlabApiBase(input.baseUrl);
  const encoded = encodeURIComponent(input.fullName);
  return get({
    url: `${apiBase}/projects/${encoded}`,
    headers: gitlabHeaders(input.accessToken),
  });
}

/**
 * Lists branches up to the cap, always including the default branch.
 * @param {{
 *   baseUrl: string | null,
 *   fullName: string,
 *   defaultBranch: string,
 *   accessToken?: string | null,
 *   outboundGet?: typeof outboundGet,
 *   limit?: number,
 * }} input Branch inputs.
 * @returns {Promise<{ branches: string[], branchesTruncated: boolean }>}
 */
export async function listGitlabBranches(input) {
  const get = input.outboundGet ?? outboundGet;
  const apiBase = gitlabApiBase(input.baseUrl);
  const encoded = encodeURIComponent(input.fullName);
  const limit = input.limit ?? REPO_BRANCH_LIST_LIMIT;
  /** @type {string[]} */
  const branches = [];
  let page = 1;
  let truncated = false;

  const pageSize = Math.min(BRANCH_PAGE_SIZE, limit);
  while (branches.length < limit) {
    const response = await get({
      url: `${apiBase}/projects/${encoded}/repository/branches?per_page=${pageSize}&page=${page}`,
      headers: gitlabHeaders(input.accessToken),
    });
    if (response.status !== 200 || !Array.isArray(response.json)) {
      break;
    }
    for (const row of response.json) {
      if (row && typeof row.name === 'string' && !branches.includes(row.name)) {
        branches.push(row.name);
      }
    }
    if (response.json.length < pageSize) {
      break;
    }
    if (branches.length >= limit) {
      truncated = true;
      break;
    }
    page += 1;
  }

  if (input.defaultBranch && !branches.includes(input.defaultBranch)) {
    branches.unshift(input.defaultBranch);
  }
  return {
    branches: branches.slice(0, limit),
    branchesTruncated: truncated || branches.length > limit,
  };
}

/**
 * Best-effort description from the project payload or a bounded README.
 * @param {{
 *   baseUrl: string | null,
 *   fullName: string,
 *   defaultBranch: string,
 *   accessToken?: string | null,
 *   providerDescription?: string | null,
 *   outboundGet?: typeof outboundGet,
 * }} input Readme inputs.
 * @returns {Promise<string | null>}
 */
export async function readGitlabDescription(input) {
  if (typeof input.providerDescription === 'string' && input.providerDescription.trim()) {
    return input.providerDescription.trim();
  }
  try {
    const get = input.outboundGet ?? outboundGet;
    const apiBase = gitlabApiBase(input.baseUrl);
    const encoded = encodeURIComponent(input.fullName);
    const filePath = encodeURIComponent('README.md');
    const response = await get({
      url: `${apiBase}/projects/${encoded}/repository/files/${filePath}?ref=${encodeURIComponent(input.defaultBranch)}`,
      headers: gitlabHeaders(input.accessToken),
    });
    if (response.status !== 200 || !response.json || typeof response.json.content !== 'string') {
      return null;
    }
    const decoded = Buffer.from(response.json.content, 'base64').toString('utf8');
    return firstReadmeParagraph(decoded);
  } catch {
    return null;
  }
}

/**
 * True when a response looks like a GitLab JSON API (not a random HTML host).
 * @param {import('./outboundHttp.js').OutboundResponse} response Outbound response.
 * @returns {boolean}
 */
export function looksLikeGitlabApi(response) {
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType.includes('json') && response.json && typeof response.json === 'object') {
    return true;
  }
  return false;
}

/**
 * @param {string | null} baseUrl Self-hosted origin or null for gitlab.com.
 * @returns {string}
 */
export function gitlabApiBase(baseUrl) {
  return `${baseUrl ?? 'https://gitlab.com'}/api/v4`;
}

/**
 * @param {string | null | undefined} accessToken Token.
 * @returns {Record<string, string>}
 */
export function gitlabHeaders(accessToken) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'codex-sage',
  };
  if (accessToken) {
    headers['PRIVATE-TOKEN'] = accessToken;
  }
  return headers;
}

/**
 * Probes a repository URL (anonymous first, then token when supplied).
 * @param {{
 *   repositoryUrl: string,
 *   accessToken?: string | null,
 * }} input Probe inputs.
 * @returns {Promise<object>} Probe DTO (always a determined probeStatus).
 */
export async function probeRepository(input) {
  let resolved;
  try {
    resolved = resolveRepositoryUrl(input.repositoryUrl);
  } catch (err) {
    throw ApiError.fromCode('VALIDATION_ERROR', {
      message: err instanceof Error ? err.message : 'repositoryUrl is invalid.',
    });
  }

  const token = typeof input.accessToken === 'string' && input.accessToken.trim() ? input.accessToken.trim() : null;

  const identity = {
    provider: resolved.provider,
    hostKind: resolved.hostKind,
    baseUrl: resolved.baseUrl,
    repository: { fullName: resolved.fullName },
  };

  let lookup;
  try {
    lookup = await lookupRepository(resolved, null);
  } catch (err) {
    return { ...identity, ...mapOutboundThrown(err), tokenUsed: false };
  }

  if (resolved.hostKind === 'gitlab_self_hosted' && !looksLikeGitlabApi(lookup)) {
    return {
      ...identity,
      probeStatus: 'unreachable',
      reason: {
        code: 'provider_not_supported',
        message: 'This host does not look like a supported GitLab instance.',
      },
      tokenUsed: false,
    };
  }

  if (lookup.status === 200 && lookup.json && typeof lookup.json === 'object') {
    return finishConnected(resolved, lookup.json, token, false);
  }

  if (!token) {
    return { ...identity, ...mapAnonymousLookupStatus(lookup.status), tokenUsed: false };
  }

  let authenticated;
  try {
    authenticated = await lookupRepository(resolved, token);
  } catch (err) {
    return { ...identity, ...mapOutboundThrown(err), tokenUsed: true };
  }

  if (resolved.hostKind === 'gitlab_self_hosted' && !looksLikeGitlabApi(authenticated)) {
    return {
      ...identity,
      probeStatus: 'unreachable',
      reason: {
        code: 'provider_not_supported',
        message: 'This host does not look like a supported GitLab instance.',
      },
      tokenUsed: true,
    };
  }

  if (authenticated.status === 200 && authenticated.json && typeof authenticated.json === 'object') {
    return finishConnected(resolved, authenticated.json, token, true);
  }

  return {
    ...identity,
    ...mapAuthenticatedLookupStatus(authenticated.status),
    tokenUsed: true,
  };

  /**
   * Calls the provider lookup for the resolved identity.
   * @param {ReturnType<typeof resolveRepositoryUrl>} resolvedUrl Parsed repository identity.
   * @param {string | null} accessToken PAT when authenticating; null for anonymous.
   * @returns {Promise<OutboundResponse>}
   */
  async function lookupRepository(resolvedUrl, accessToken) {
    if (resolvedUrl.provider === 'github') {
      return lookupGithubRepository({
        ownerPath: resolvedUrl.ownerPath,
        repoSlug: resolvedUrl.repoSlug,
        accessToken,
      });
    }
    return lookupGitlabProject({
      baseUrl: resolvedUrl.baseUrl,
      fullName: resolvedUrl.fullName,
      accessToken,
    });
  }

  /**
   * Builds the connected probe DTO after a successful identity lookup.
   * @param {ReturnType<typeof resolveRepositoryUrl>} resolvedUrl Parsed repository identity.
   * @param {object} payload Provider JSON body from a 200 lookup.
   * @param {string | null} accessToken Token used for follow-up branch/README calls.
   * @param {boolean} tokenUsed Whether the successful lookup used a token.
   * @returns {Promise<object>}
   */
  async function finishConnected(resolvedUrl, payload, accessToken, tokenUsed) {
    const visibility = readVisibility(payload);
    const webUrl =
      typeof payload.html_url === 'string' ? payload.html_url : typeof payload.web_url === 'string' ? payload.web_url : resolvedUrl.webUrl;
    const defaultBranch = (typeof payload.default_branch === 'string' && payload.default_branch) || 'main';
    const providerDescription = typeof payload.description === 'string' ? payload.description : null;

    let branches = [defaultBranch];
    let branchesTruncated = false;
    let description = providerDescription && providerDescription.trim() ? providerDescription.trim() : null;

    try {
      if (resolvedUrl.provider === 'github') {
        const listed = await listGithubBranches({
          ownerPath: resolvedUrl.ownerPath,
          repoSlug: resolvedUrl.repoSlug,
          defaultBranch,
          accessToken,
        });
        branches = listed.branches;
        branchesTruncated = listed.branchesTruncated;
        description = await readGithubDescription({
          ownerPath: resolvedUrl.ownerPath,
          repoSlug: resolvedUrl.repoSlug,
          accessToken,
          providerDescription,
        });
      } else {
        const listed = await listGitlabBranches({
          baseUrl: resolvedUrl.baseUrl,
          fullName: resolvedUrl.fullName,
          defaultBranch,
          accessToken,
        });
        branches = listed.branches;
        branchesTruncated = listed.branchesTruncated;
        description = await readGitlabDescription({
          baseUrl: resolvedUrl.baseUrl,
          fullName: resolvedUrl.fullName,
          defaultBranch,
          accessToken,
          providerDescription,
        });
      }
    } catch {
      // Branch/README failures must not fail a successful identity lookup.
    }

    return {
      probeStatus: 'connected',
      provider: resolvedUrl.provider,
      hostKind: resolvedUrl.hostKind,
      baseUrl: resolvedUrl.baseUrl,
      repository: {
        fullName: resolvedUrl.fullName,
        webUrl,
        visibility,
        description,
      },
      defaultBranch,
      branches,
      branchesTruncated,
      tokenUsed,
    };

    /**
     * Maps provider private/visibility fields into the probe DTO value.
     * @param {object} providerPayload Provider JSON.
     * @returns {string | null}
     */
    function readVisibility(providerPayload) {
      if (providerPayload.private === true) {
        return 'private';
      }
      if (providerPayload.private === false) {
        return 'public';
      }
      if (typeof providerPayload.visibility === 'string') {
        return providerPayload.visibility;
      }
      return null;
    }
  }
}

/**
 * @param {MappedProbeError['probeStatus']} probeStatus Status.
 * @param {string} reasonCode Reason code.
 * @returns {MappedProbeError}
 */
function mapped(probeStatus, reasonCode) {
  return {
    probeStatus,
    reason: {
      code: reasonCode,
      message: USER_MESSAGES[reasonCode] ?? USER_MESSAGES.provider_unavailable,
    },
  };
}
