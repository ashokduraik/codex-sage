/**
 * Tenant-safe paths for the on-disk `.codegraph` index under a project workspace.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPathInsideRoot } from '../workspace/index.js';

/** Default CodeGraph data directory name (library default; CODEGRAPH_DIR override not used). */
export const CODEGRAPH_DIR_NAME = '.codegraph';

/** Project-scoped exclusion config filename written before index/sync. */
export const CODEGRAPH_PROJECT_CONFIG_FILENAME = 'codegraph.json';

/**
 * Resolves the absolute `.codegraph` directory under a workspace and asserts it stays inside.
 * @param {string} workspacePath Absolute project workspace directory.
 * @returns {string} Absolute graph directory path.
 */
export function resolveCodegraphDir(workspacePath) {
  const resolvedWorkspace = path.resolve(workspacePath);
  const graphDir = path.resolve(resolvedWorkspace, CODEGRAPH_DIR_NAME);
  assertPathInsideRoot(resolvedWorkspace, graphDir);
  return graphDir;
}

/**
 * Returns true when a CodeGraph index directory already exists under the workspace.
 * @param {string} workspacePath Absolute project workspace directory.
 * @returns {Promise<boolean>}
 */
export async function codegraphIndexExists(workspacePath) {
  const graphDir = resolveCodegraphDir(workspacePath);
  try {
    const stats = await fs.stat(graphDir);
    return stats.isDirectory();
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Writes `codegraph.json` exclude patterns so S2-excluded paths are not indexed.
 * @param {string} workspacePath Absolute project workspace.
 * @param {string[]} excludedRelativePaths Repo-relative paths marked excludedFromGraph.
 * @returns {Promise<void>}
 */
export async function writeCodegraphExcludeConfig(workspacePath, excludedRelativePaths) {
  const resolvedWorkspace = path.resolve(workspacePath);
  const configPath = path.resolve(resolvedWorkspace, CODEGRAPH_PROJECT_CONFIG_FILENAME);
  assertPathInsideRoot(resolvedWorkspace, configPath);

  const exclude = [...new Set(excludedRelativePaths.filter((p) => typeof p === 'string' && p.length > 0))];
  const body = `${JSON.stringify({ exclude }, null, 2)}\n`;
  await fs.writeFile(configPath, body, 'utf8');
}
