/**
 * GitLab REST calls for SaaS and self-hosted repository probes.
 */
import { outboundGet } from './outboundHttp.js';
import { firstReadmeParagraph, REPO_BRANCH_LIST_LIMIT } from './githubProbe.js';

const BRANCH_PAGE_SIZE = 100;

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
function gitlabApiBase(baseUrl) {
  return `${baseUrl ?? 'https://gitlab.com'}/api/v4`;
}

/**
 * @param {string | null | undefined} accessToken Token.
 * @returns {Record<string, string>}
 */
function gitlabHeaders(accessToken) {
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
