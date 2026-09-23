/**
 * GitHub REST calls for repository probe (lookup, branches, optional README).
 */
import { outboundGet } from './outboundHttp.js';

export const REPO_BRANCH_LIST_LIMIT = 200;
export const REPO_README_MAX_BYTES = 65_536;
const BRANCH_PAGE_SIZE = 100;

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
      url:
        `https://api.github.com/repos/${encodeURIComponent(input.ownerPath)}/` +
        `${encodeURIComponent(input.repoSlug)}/readme`,
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
