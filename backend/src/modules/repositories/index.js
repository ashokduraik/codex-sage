/**
 * Public surface of the repositories module (probe in Phase 30; attach in Phase 31).
 */
export { repositoryRoutes } from './repositories.routes.js';
export { probeRepository } from './repositoryProbe.service.js';
export { resolveRepositoryUrl } from './providers/providerResolver.js';
export {
  mapAnonymousLookupStatus,
  mapAuthenticatedLookupStatus,
  mapOutboundThrown,
} from './providers/probeErrorMap.js';
export { outboundGet, REPO_PROBE_TIMEOUT_MS } from './providers/outboundHttp.js';
export { REPO_BRANCH_LIST_LIMIT, REPO_README_MAX_BYTES } from './providers/githubProbe.js';
export { RepositoryConnection } from './repositoryConnection.model.js';
export { RepositoryCredential } from './repositoryCredential.model.js';
export {
  attachRepository,
  getRepositoryConnection,
  mapConnectionToDto,
  patchRepositoryBranch,
  replaceRepositoryCredential,
  retestRepositoryConnection,
  revokeRepositoryCredential,
} from './repositoryAttach.service.js';

import { RepositoryConnection } from './repositoryConnection.model.js';
import { RepositoryCredential } from './repositoryCredential.model.js';

/** Models whose indexes are synced on development API startup / worker / tests. */
export const REPOSITORY_MODELS = Object.freeze([
  RepositoryConnection,
  RepositoryCredential,
]);
