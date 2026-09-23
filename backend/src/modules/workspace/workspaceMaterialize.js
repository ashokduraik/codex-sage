/**
 * GridFS → disk materialization and project workspace subtree reset.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { openSourceGridFsDownloadStream } from '../sources/index.js';
import { assertPathInsideRoot, resolveSafeWorkspaceFilePath } from './workspacePaths.js';

/**
 * Removes all entries under the project workspace directory without deleting WORKSPACE_ROOT.
 * Creates the directory when missing.
 * @param {string} workspacePath Absolute project workspace path.
 * @param {string} workspaceRoot Absolute WORKSPACE_ROOT (must be a strict ancestor).
 * @returns {Promise<void>}
 */
export async function resetProjectWorkspaceSubtree(workspacePath, workspaceRoot) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedProject = path.resolve(workspacePath);
  assertPathInsideRoot(resolvedRoot, resolvedProject);
  if (resolvedProject === resolvedRoot) {
    throw Object.assign(new Error('Refusing to reset WORKSPACE_ROOT itself.'), {
      code: 'WORKSPACE_PATH_UNSAFE',
    });
  }
  await fs.rm(resolvedProject, { recursive: true, force: true });
  await fs.mkdir(resolvedProject, { recursive: true });
}

/**
 * Deletes one repo-relative file from the project workspace (missing is ok).
 * @param {string} workspacePath Absolute project workspace path.
 * @param {string} relativePath Repo-relative path.
 * @returns {Promise<void>}
 */
export async function deleteWorkspaceRelativePath(workspacePath, relativePath) {
  const absoluteFile = resolveSafeWorkspaceFilePath(workspacePath, relativePath);
  await fs.rm(absoluteFile, { force: true });
}

/**
 * Streams one GridFS object to a safe path under the project workspace.
 * @param {{
 *   workspacePath: string,
 *   relativePath: string,
 *   gridFsId: import('mongoose').Types.ObjectId | string,
 * }} input Materialize inputs.
 * @returns {Promise<string>} Absolute path written.
 */
export async function materializeGridFsFileToDisk(input) {
  const absoluteFile = resolveSafeWorkspaceFilePath(input.workspacePath, input.relativePath);
  await fs.mkdir(path.dirname(absoluteFile), { recursive: true });
  const download = openSourceGridFsDownloadStream(input.gridFsId);
  try {
    await pipeline(download, createWriteStream(absoluteFile));
  } catch (err) {
    // Best-effort cleanup of a partial write.
    await fs.rm(absoluteFile, { force: true }).catch(() => {});
    throw err;
  }
  return absoluteFile;
}
