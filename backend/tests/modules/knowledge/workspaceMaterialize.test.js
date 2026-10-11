/**
 * Unit tests for workspace reset and GridFS→disk materialization.
 */
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { createMongoHarness } from '../../mongoHarness.js';
import { clearSourceFilesBucket } from '../../clearSourceFilesBucket.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getSourceFilesBucket } from '../../../src/modules/knowledge/sources.js';
import { materializeGridFsFileToDisk, resetProjectWorkspaceSubtree } from '../../../src/modules/knowledge/sources.js';

const harness = createMongoHarness({
  models: [],
  uri: TEST_APP_CONFIG.mongo.uri,
});

let workspaceRoot;

describe('workspaceMaterialize', () => {
  beforeAll(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sage-ws-mat-'));
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await clearSourceFilesBucket();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterAll(async () => {
    await harness.afterAll();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('resets only the project subtree and streams GridFS bytes to disk', async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    const projectId = new mongoose.Types.ObjectId().toString();
    const workspacePath = path.join(workspaceRoot, orgId, projectId);
    await fs.mkdir(path.join(workspacePath, 'old'), { recursive: true });
    await fs.writeFile(path.join(workspacePath, 'old', 'gone.js'), 'old');

    await resetProjectWorkspaceSubtree(workspacePath, workspaceRoot);
    await expect(fs.stat(path.join(workspacePath, 'old', 'gone.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.stat(workspacePath)).toBeTruthy();

    const content = Buffer.from('export const ok = true;\n');
    const bucket = getSourceFilesBucket();
    const upload = bucket.openUploadStream('mat/test.js', {
      metadata: {
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    });
    await new Promise((resolve, reject) => {
      Readable.from(content).pipe(upload).on('finish', resolve).on('error', reject);
    });

    const written = await materializeGridFsFileToDisk({
      workspacePath,
      relativePath: 'src/ok.js',
      gridFsId: upload.id,
    });
    expect(await fs.readFile(written, 'utf8')).toBe(content.toString('utf8'));
  });

  it('refuses to reset WORKSPACE_ROOT itself', async () => {
    await expect(resetProjectWorkspaceSubtree(workspaceRoot, workspaceRoot)).rejects.toMatchObject({
      code: 'WORKSPACE_PATH_UNSAFE',
    });
  });
});
