/**
 * Optional integration tests against the real `@colbymchenry/codegraph` package.
 * Skipped when the library cannot be loaded (document for phase 63 CI).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codegraphIndexExists,
  createCodegraphAdapter,
  isCodegraphLoadable,
} from '../../../src/modules/knowledge/codegraph.js';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/codegraph',
);

const codegraphAvailable = await isCodegraphLoadable();

describe.skipIf(!codegraphAvailable)('codegraph integration (real library)', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  /**
   * Copies the fixture tree into a unique temp workspace.
   * @returns {Promise<string>}
   */
  async function copyFixtureWorkspace() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-int-'));
    tempDirs.push(dir);
    await fs.cp(FIXTURE_ROOT, dir, { recursive: true });
    return dir;
  }

  it('full index produces .codegraph and validate passes', async () => {
    const workspace = await copyFixtureWorkspace();
    const adapter = createCodegraphAdapter();
    adapter.configureTelemetryOff();
    const release = await adapter.acquireWriter({ orgId: 'int', projectId: 'fixture' });
    try {
      const indexed = await adapter.indexAll(workspace, { excludedPaths: [] });
      expect(await codegraphIndexExists(workspace)).toBe(true);
      const validation = await adapter.validate(workspace, {
        graph: indexed.graph,
        sourceVersionId: 'fixture-sv',
        mode: 'indexAll',
        indexedFileCount: indexed.indexedFileCount,
        skippedFileCount: indexed.skippedFileCount,
        expectedIndexedFileCount: 100,
        expectedExcludedCount: 0,
        graphPath: indexed.graphPath,
        graphHash: indexed.graphHash,
      });
      expect(validation.hardFail).toBe(false);
      expect(validation.identity.graphPath).toContain('.codegraph');
      indexed.graph?.close?.();
    } finally {
      adapter.releaseWriter(release);
    }
  }, 120_000);

  it('second run uses sync when the index already exists', async () => {
    const workspace = await copyFixtureWorkspace();
    const adapter = createCodegraphAdapter();
    const release = await adapter.acquireWriter({ orgId: 'int', projectId: 'fixture2' });
    try {
      const first = await adapter.indexAll(workspace, {});
      first.graph?.close?.();
      expect(await codegraphIndexExists(workspace)).toBe(true);
      const synced = await adapter.sync(workspace, {});
      expect(synced.mode).toBe('sync');
      synced.graph?.close?.();
    } finally {
      adapter.releaseWriter(release);
    }
  }, 120_000);
});

describe('codegraph integration skip documentation', () => {
  it('records whether the library loaded (for phase 63 CI)', () => {
    // When false, the suite above is skipped because the optional native
    // package or Node sqlite backend is unavailable in this environment.
    expect(typeof codegraphAvailable).toBe('boolean');
  });
});
