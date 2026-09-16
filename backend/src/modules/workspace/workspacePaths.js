/**
 * Tenant-safe workspace path join and boundary checks.
 */
import path from 'node:path';
import { normalizeArchivePath, isUnsafeArchivePath } from '../sources/index.js';

/**
 * Builds the absolute project workspace directory under WORKSPACE_ROOT.
 * @param {string} workspaceRoot Absolute WORKSPACE_ROOT.
 * @param {string} orgId Organization id.
 * @param {string} projectId Project id.
 * @returns {string} Absolute project workspace path.
 * @throws {Error} When ids are empty or the resolved path escapes the root.
 */
export function resolveProjectWorkspacePath(workspaceRoot, orgId, projectId) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot)) {
    throw Object.assign(new Error('WORKSPACE_ROOT must be an absolute path.'), {
      code: 'WORKSPACE_ROOT_INVALID',
    });
  }
  const org = String(orgId ?? '');
  const project = String(projectId ?? '');
  if (!org || !project || org.includes('..') || project.includes('..') || org.includes('/') || project.includes('/')) {
    throw Object.assign(new Error('Organization or project id is unsafe for a workspace path.'), {
      code: 'WORKSPACE_PATH_UNSAFE',
    });
  }
  const resolvedRoot = path.resolve(workspaceRoot);
  const projectPath = path.resolve(resolvedRoot, org, project);
  assertPathInsideRoot(resolvedRoot, projectPath);
  return projectPath;
}

/**
 * Resolves a repo-relative file path under the project workspace; fails closed on escape.
 * @param {string} workspacePath Absolute project workspace directory.
 * @param {string} relativePath Repo-relative path (may need normalization).
 * @returns {string} Absolute file path under workspacePath.
 * @throws {{ code: string, message: string }} When the path is unsafe.
 */
export function resolveSafeWorkspaceFilePath(workspacePath, relativePath) {
  const normalized = normalizeArchivePath(relativePath);
  if (isUnsafeArchivePath(normalized)) {
    throw Object.assign(new Error('Source path is unsafe for workspace materialization.'), {
      code: 'WORKSPACE_PATH_UNSAFE',
    });
  }
  const resolvedRoot = path.resolve(workspacePath);
  const absoluteFile = path.resolve(resolvedRoot, ...normalized.split('/'));
  assertPathInsideRoot(resolvedRoot, absoluteFile);
  return absoluteFile;
}

/**
 * Asserts that candidate stays under root (or equals root).
 * @param {string} root Absolute root directory.
 * @param {string} candidate Absolute candidate path.
 * @returns {void}
 * @throws {{ code: string, message: string }}
 */
export function assertPathInsideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate === resolvedRoot) {
    return;
  }
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (!resolvedCandidate.startsWith(prefix)) {
    throw Object.assign(new Error('Resolved path escapes the workspace root.'), {
      code: 'WORKSPACE_PATH_UNSAFE',
    });
  }
}
