/**
 * Unit tests for source upload persistence helpers.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { GRAPH_FILE_MAX_BYTES } from './exclusions/exclusions.constants.js';
import { summarizeInspection } from './exclusions/pathDecision.js';
import {
  clearSourceFilesBucket,
  getSourceFilesBucket,
  GRIDFS_SOURCE_BUCKET,
} from './index.js';
import { kindForSourcePath, storeAcceptedZipEntries } from './upload.service.js';
import { SourceFile, SourceVersion } from './index.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'exclusions',
  'fixtures',
);

const harness = createMongoHarness({
  models: [SourceVersion, SourceFile],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('sourceFileKind', () => {
  it('maps code, config, and doc paths', () => {
    expect(kindForSourcePath('src/a.js')).toBe('code');
    expect(kindForSourcePath('README.md')).toBe('doc');
    expect(kindForSourcePath('package.json')).toBe('config');
    expect(kindForSourcePath('.prettierrc')).toBe('config');
    expect(kindForSourcePath('Makefile')).toBe('code');
  });
});

describe('storeAcceptedZipEntries', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
    await clearSourceFilesBucket();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('does not open GridFS for skipped paths and stores only accepted entries', async () => {
    const archiveBuffer = await readFile(path.join(fixturesDir, 'good.zip'));
    const orgId = new mongoose.Types.ObjectId().toString();
    const projectId = new mongoose.Types.ObjectId().toString();
    const sourceVersionId = new mongoose.Types.ObjectId().toString();

    const openSpy = vi.spyOn(mongoose.mongo.GridFSBucket.prototype, 'openUploadStream');

    const result = await storeAcceptedZipEntries({
      archiveBuffer,
      accepted: [
        {
          path: 'src/a.js',
          size: 20,
          excludedFromGraph: false,
        },
      ],
      orgId,
      projectId,
      sourceVersionId,
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/a.js');
    expect(result.files[0].kind).toBe('code');
    expect(result.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(openSpy.mock.calls.length).toBe(1);
    expect(openSpy.mock.calls[0][0]).toContain('src/a.js');

    const bucket = getSourceFilesBucket();
    const files = await bucket.find({}).toArray();
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe(
      `${orgId}/${projectId}/${sourceVersionId}/src/a.js`,
    );
    expect(files[0].metadata.path).toBe('src/a.js');

    openSpy.mockRestore();
  });

  it('sets excludedFromGraph for oversize accepted files from inspection', () => {
    const inspection = summarizeInspection([
      { path: 'huge.js', uncompressedSize: GRAPH_FILE_MAX_BYTES + 1 },
      { path: 'ok.js', uncompressedSize: 10 },
    ]);
    const huge = inspection.accepted.find((row) => row.path === 'huge.js');
    expect(huge?.excludedFromGraph).toBe(true);
    expect(huge?.exclusionReason).toBe('file_too_large');
  });

  it('response mapper surface returns only ids (no gridFsId leak)', () => {
    const body = {
      sourceVersionId: '665a00000000000000000001',
      jobId: '665f1c9d4b2a8e0012a4f001',
    };
    expect(Object.keys(body).sort()).toEqual(['jobId', 'sourceVersionId']);
    expect(body).not.toHaveProperty('gridFsId');
  });

  it('hashes archive content for idempotency identity', () => {
    const bytes = Buffer.from('zip-bytes');
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(digest).toHaveLength(64);
    expect(GRIDFS_SOURCE_BUCKET).toBe('sourceFiles');
  });

  it('marks orphans and aborts when an accepted path is missing from the zip', async () => {
    const archiveBuffer = await readFile(path.join(fixturesDir, 'valid-small.zip'));
    const orgId = new mongoose.Types.ObjectId().toString();
    const projectId = new mongoose.Types.ObjectId().toString();
    const sourceVersionId = new mongoose.Types.ObjectId().toString();

    await expect(
      storeAcceptedZipEntries({
        archiveBuffer,
        accepted: [
          {
            path: 'does-not-exist.js',
            size: 1,
            excludedFromGraph: false,
          },
        ],
        orgId,
        projectId,
        sourceVersionId,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_ZIP_INTEGRITY' });
  });

  it('propagates GridFS upload stream failures and marks orphans', async () => {
    const archiveBuffer = await readFile(path.join(fixturesDir, 'good.zip'));
    const orgId = new mongoose.Types.ObjectId().toString();
    const projectId = new mongoose.Types.ObjectId().toString();
    const sourceVersionId = new mongoose.Types.ObjectId().toString();

    const bucketProto = mongoose.mongo.GridFSBucket.prototype;
    const originalOpen = bucketProto.openUploadStream;
    const openSpy = vi
      .spyOn(bucketProto, 'openUploadStream')
      .mockImplementation(function mockOpen(...args) {
        const stream = originalOpen.apply(this, args);
        queueMicrotask(() => stream.destroy(new Error('forced upload failure')));
        return stream;
      });

    await expect(
      storeAcceptedZipEntries({
        archiveBuffer,
        accepted: [
          {
            path: 'src/a.js',
            size: 20,
            excludedFromGraph: false,
          },
        ],
        orgId,
        projectId,
        sourceVersionId,
      }),
    ).rejects.toThrow();

    openSpy.mockRestore();
  });
});
