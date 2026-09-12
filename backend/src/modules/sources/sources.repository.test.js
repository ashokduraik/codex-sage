/**
 * Unit tests for GridFS helpers and source repository.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import {
  SourceFile,
  SourceVersion,
  buildSourceGridFsFilename,
  clearSourceFilesBucket,
  countSourceVersions,
  findSourceVersionById,
  getSourceFilesBucket,
  insertSourceFiles,
  insertSourceVersion,
  listSourceFilesForVersion,
  markGridFsFilesOrphaned,
} from './index.js';
import { EXCLUSION_RULESET_ID } from './exclusions/exclusions.constants.js';

const harness = createMongoHarness({
  models: [SourceVersion, SourceFile],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('sources gridfs + repository', () => {
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

  it('builds tenant-safe GridFS filenames', () => {
    expect(
      buildSourceGridFsFilename({
        orgId: 'o1',
        projectId: 'p1',
        sourceVersionId: 'v1',
        path: 'src/a.js',
      }),
    ).toBe('o1/p1/v1/src/a.js');
  });

  it('marks GridFS files orphaned and clears the bucket', async () => {
    const bucket = getSourceFilesBucket();
    const upload = bucket.openUploadStream('tmp/orphan.txt', {
      metadata: { orgId: 'o', projectId: 'p', sourceVersionId: 'v', path: 'orphan.txt' },
    });
    upload.end(Buffer.from('x'));
    await new Promise((resolve, reject) => {
      upload.on('finish', resolve);
      upload.on('error', reject);
    });

    await markGridFsFilesOrphaned([]);
    await markGridFsFilesOrphaned([upload.id]);

    const files = await bucket.find({ _id: upload.id }).toArray();
    expect(files[0].metadata.orphanedAt).toBeInstanceOf(Date);

    await clearSourceFilesBucket();
    expect(await bucket.find({}).toArray()).toHaveLength(0);
  });

  it('inserts and lists source versions and files', async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    const projectId = new mongoose.Types.ObjectId().toString();
    const sourceVersionId = new mongoose.Types.ObjectId().toString();
    const actorId = new mongoose.Types.ObjectId().toString();
    const gridFsId = new mongoose.Types.ObjectId();

    await insertSourceVersion({
      orgId,
      projectId,
      sourceVersionId,
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: actorId,
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    });

    await insertSourceFiles({
      orgId,
      projectId,
      sourceVersionId,
      createdBy: actorId,
      files: [
        {
          path: 'src/a.js',
          sha256: 'a'.repeat(64),
          byteLength: 12,
          kind: 'code',
          gridFsId,
          excludedFromGraph: false,
          exclusionReason: null,
        },
      ],
    });

    expect(await countSourceVersions(orgId, projectId)).toBe(1);
    const version = await findSourceVersionById(orgId, sourceVersionId);
    expect(version).toBeTruthy();
    expect(await findSourceVersionById(orgId, 'not-an-id')).toBeNull();

    const files = await listSourceFilesForVersion(orgId, sourceVersionId);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/a.js');

    await insertSourceFiles({
      orgId,
      projectId,
      sourceVersionId,
      createdBy: actorId,
      files: [],
    });
  });
});
