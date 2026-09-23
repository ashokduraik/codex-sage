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
}

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
