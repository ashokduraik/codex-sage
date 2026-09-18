/**
 * Unit tests for CodeGraph path helpers.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEGRAPH_DIR_NAME,
  CODEGRAPH_PROJECT_CONFIG_FILENAME,
  codegraphIndexExists,
  resolveCodegraphDir,
  writeCodegraphExcludeConfig,
} from './codegraph.paths.js';

describe('codegraph.paths', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  /**
   * @returns {Promise<string>}
   */
  async function makeTempWorkspace() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-paths-'));
    tempDirs.push(dir);
    return dir;
  }

  it('resolves .codegraph under the workspace', async () => {
    const workspace = await makeTempWorkspace();
    expect(resolveCodegraphDir(workspace)).toBe(path.join(workspace, CODEGRAPH_DIR_NAME));
  });

  it('reports whether the index directory exists', async () => {
    const workspace = await makeTempWorkspace();
    expect(await codegraphIndexExists(workspace)).toBe(false);
    await fs.mkdir(path.join(workspace, CODEGRAPH_DIR_NAME));
    expect(await codegraphIndexExists(workspace)).toBe(true);
  });

  it('writes codegraph.json exclude patterns for S2 exclusions', async () => {
    const workspace = await makeTempWorkspace();
    await writeCodegraphExcludeConfig(workspace, ['big/file.js', 'big/file.js', 'skip/me.ts']);
    const raw = await fs.readFile(
      path.join(workspace, CODEGRAPH_PROJECT_CONFIG_FILENAME),
      'utf8',
    );
    expect(JSON.parse(raw)).toEqual({
      exclude: ['big/file.js', 'skip/me.ts'],
    });
  });

  it('rethrows non-ENOENT stat errors from codegraphIndexExists', async () => {
    const workspace = await makeTempWorkspace();
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    try {
      await expect(codegraphIndexExists(workspace)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      vi.restoreAllMocks();
    }
  });
});
