/**
 * Unit tests for GridFS helpers and source repository.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { clearSourceFilesBucket } from '../../clearSourceFilesBucket.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import {
  SourceFile,
  SourceVersion,
  computeSourceDiff,
  buildSourceGridFsFilename,
  countSourceVersions,
  findActiveSourceVersionForProject,
  findSourceFileByPath,
  findSourceVersionById,
  readSourceGridFsBytes,
  getSourceFilesBucket,
  insertSourceFiles,
  insertSourceVersion,
  listSourceFilePathHashesPage,
  listSourceFilesForVersion,
  listSourceVersionsByProject,
  markGridFsFilesOrphaned,
} from '../../../src/modules/knowledge/sources.js';
import { EXCLUSION_RULESET_ID } from '../../../src/modules/knowledge/uploads.js';

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

    const uploaded = await readSourceGridFsBytes(upload.id);
    expect(uploaded.toString('utf8')).toBe('x');

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
    const byPath = await findSourceFileByPath({
      orgId,
      projectId,
      sourceVersionId,
      path: 'src/a.js',
    });
    expect(byPath?.sha256).toBe('a'.repeat(64));
    expect(
      await findSourceFileByPath({
        orgId,
        projectId,
        sourceVersionId,
        path: '',
      }),
    ).toBeNull();
    const page = await listSourceFilePathHashesPage({
      orgId,
      projectId,
      sourceVersionId,
      limit: 10,
    });
    expect(page).toEqual([{ path: 'src/a.js', sha256: 'a'.repeat(64) }]);
    expect(
      await findActiveSourceVersionForProject(orgId, projectId, sourceVersionId),
    ).toBeTruthy();
    expect(
      await findActiveSourceVersionForProject(
        orgId,
        projectId,
        new mongoose.Types.ObjectId().toString(),
      ),
    ).toBeNull();

    await insertSourceFiles({
      orgId,
      projectId,
      sourceVersionId,
      createdBy: actorId,
      files: [],
    });

    const incomingId = new mongoose.Types.ObjectId().toString();
    await insertSourceVersion({
      orgId,
      projectId,
      sourceVersionId: incomingId,
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: actorId,
      fileCounts: { accepted: 2, skipped: 0, excludedFromGraph: 0 },
    });
    await insertSourceFiles({
      orgId,
      projectId,
      sourceVersionId: incomingId,
      createdBy: actorId,
      files: [
        {
          path: 'src/a.js',
          sha256: 'a'.repeat(64),
          byteLength: 12,
          kind: 'code',
          gridFsId: new mongoose.Types.ObjectId(),
          excludedFromGraph: false,
        },
        {
          path: 'src/b.js',
          sha256: 'b'.repeat(64),
          byteLength: 4,
          kind: 'code',
          gridFsId: new mongoose.Types.ObjectId(),
          excludedFromGraph: false,
        },
      ],
    });
    const diff = await computeSourceDiff({
      orgId,
      projectId,
      incomingSourceVersionId: incomingId,
      publishedSourceVersionId: sourceVersionId,
    });
    expect(diff.unchanged).toEqual(['src/a.js']);
    expect(diff.added).toEqual(['src/b.js']);
    expect(diff.removed).toEqual([]);
  });

  it('pages source versions by createdAt and ignores invalid project ids', async () => {
    const orgId = new mongoose.Types.ObjectId().toString();
    const projectId = new mongoose.Types.ObjectId().toString();
    const actorId = new mongoose.Types.ObjectId().toString();
    await insertSourceVersion({
      orgId,
      projectId,
      sourceVersionId: new mongoose.Types.ObjectId().toString(),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: actorId,
      fileCounts: { accepted: 1, skipped: 0, excludedFromGraph: 0 },
    });
    await insertSourceVersion({
      orgId,
      projectId,
      sourceVersionId: new mongoose.Types.ObjectId().toString(),
      exclusionRulesetId: EXCLUSION_RULESET_ID,
      createdBy: actorId,
      fileCounts: { accepted: 2, skipped: 0, excludedFromGraph: 0 },
    });
    const page1 = await listSourceVersionsByProject(orgId, projectId, { limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.pageInfo.hasMore).toBe(true);
    const page2 = await listSourceVersionsByProject(orgId, projectId, {
      limit: 1,
      cursor: page1.pageInfo.nextCursor,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.pageInfo.hasMore).toBe(false);
    expect(await listSourceVersionsByProject(orgId, 'not-an-id')).toEqual({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
  });
});
