/**
 * Stateless repository probe orchestration (Phase 30).
 */
import { ApiError } from '../../platform/errors.js';
import { resolveRepositoryUrl } from './providers/providerResolver.js';
import {
  listGithubBranches,
  lookupGithubRepository,
  readGithubDescription,
} from './providers/githubProbe.js';
import {
  listGitlabBranches,
  lookupGitlabProject,
  looksLikeGitlabApi,
  readGitlabDescription,
} from './providers/gitlabProbe.js';
import {
  mapAnonymousLookupStatus,
  mapAuthenticatedLookupStatus,
  mapOutboundThrown,
} from './providers/probeErrorMap.js';

/**
 * Probes a repository URL (anonymous first, then token when supplied).
 * @param {{
 *   repositoryUrl: string,
 *   accessToken?: string | null,
 *   deps?: {
 *     lookupGithub?: typeof lookupGithubRepository,
 *     lookupGitlab?: typeof lookupGitlabProject,
 *     listGithubBranches?: typeof listGithubBranches,
 *     listGitlabBranches?: typeof listGitlabBranches,
 *     readGithubDescription?: typeof readGithubDescription,
 *     readGitlabDescription?: typeof readGitlabDescription,
 *   },
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

  const token = typeof input.accessToken === 'string' && input.accessToken.trim()
    ? input.accessToken.trim()
    : null;
  const deps = input.deps ?? {};

  const identity = {
    provider: resolved.provider,
    hostKind: resolved.hostKind,
    baseUrl: resolved.baseUrl,
    repository: { fullName: resolved.fullName },
  };

  let lookup;
  try {
    lookup = await lookupRepository(resolved, null, deps);
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
    return finishConnected(resolved, lookup.json, token, deps, false);
  }

  if (!token) {
    return { ...identity, ...mapAnonymousLookupStatus(lookup.status), tokenUsed: false };
  }

  let authenticated;
  try {
    authenticated = await lookupRepository(resolved, token, deps);
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
    return finishConnected(resolved, authenticated.json, token, deps, true);
  }

  return {
    ...identity,
    ...mapAuthenticatedLookupStatus(authenticated.status),
    tokenUsed: true,
  };
}

/**
 * @param {import('./providers/providerResolver.js').ResolvedRepository} resolved
 * @param {string | null} accessToken
 * @param {object} deps
 */
async function lookupRepository(resolved, accessToken, deps) {
  if (resolved.provider === 'github') {
    const lookup = deps.lookupGithub ?? lookupGithubRepository;
    return lookup({
      ownerPath: resolved.ownerPath,
      repoSlug: resolved.repoSlug,
      accessToken,
    });
  }
  const lookup = deps.lookupGitlab ?? lookupGitlabProject;
  return lookup({
    baseUrl: resolved.baseUrl,
    fullName: resolved.fullName,
    accessToken,
  });
}

/**
 * @param {import('./providers/providerResolver.js').ResolvedRepository} resolved
 * @param {object} payload
 * @param {string | null} accessToken
 * @param {object} deps
 * @param {boolean} tokenUsed
 */
async function finishConnected(resolved, payload, accessToken, deps, tokenUsed) {
  const visibility = readVisibility(payload);
  const webUrl =
    typeof payload.html_url === 'string'
      ? payload.html_url
      : typeof payload.web_url === 'string'
        ? payload.web_url
        : resolved.webUrl;
  const defaultBranch =
    (typeof payload.default_branch === 'string' && payload.default_branch) || 'main';
  const providerDescription =
    typeof payload.description === 'string' ? payload.description : null;

  let branches = [defaultBranch];
  let branchesTruncated = false;
  let description = providerDescription && providerDescription.trim()
    ? providerDescription.trim()
    : null;

  try {
    if (resolved.provider === 'github') {
      const list = deps.listGithubBranches ?? listGithubBranches;
      const listed = await list({
        ownerPath: resolved.ownerPath,
        repoSlug: resolved.repoSlug,
        defaultBranch,
        accessToken,
      });
      branches = listed.branches;
      branchesTruncated = listed.branchesTruncated;
      const readDescription = deps.readGithubDescription ?? readGithubDescription;
      description = await readDescription({
        ownerPath: resolved.ownerPath,
        repoSlug: resolved.repoSlug,
        accessToken,
        providerDescription,
      });
    } else {
      const list = deps.listGitlabBranches ?? listGitlabBranches;
      const listed = await list({
        baseUrl: resolved.baseUrl,
        fullName: resolved.fullName,
        defaultBranch,
        accessToken,
      });
      branches = listed.branches;
      branchesTruncated = listed.branchesTruncated;
      const readDescription = deps.readGitlabDescription ?? readGitlabDescription;
      description = await readDescription({
        baseUrl: resolved.baseUrl,
        fullName: resolved.fullName,
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
    provider: resolved.provider,
    hostKind: resolved.hostKind,
    baseUrl: resolved.baseUrl,
    repository: {
      fullName: resolved.fullName,
      webUrl,
      visibility,
      description,
    },
    defaultBranch,
    branches,
    branchesTruncated,
    tokenUsed,
  };
}

/**
 * @param {object} payload Provider JSON.
 * @returns {string | null}
 */
function readVisibility(payload) {
  if (payload.private === true) {
    return 'private';
  }
  if (payload.private === false) {
    return 'public';
  }
  if (typeof payload.visibility === 'string') {
    return payload.visibility;
  }
  return null;
}
