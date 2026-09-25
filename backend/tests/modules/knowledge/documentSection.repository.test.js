/**
 * Integration tests for DocumentSection repository soft-delete and insert.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { DocumentSection } from '../../../src/models/documentSection.model.js';
import {
  copySectionsForPaths,
  countSectionsForVersion,
  findDocumentSectionById,
  insertDocumentSections,
  listSectionsForPath,
  listSectionsForVersion,
  searchDocumentSections,
  softDeleteSectionsForPath,
  softDeleteSectionsForVersion,
} from '../../../src/modules/knowledge/documents.js';

const harness = createMongoHarness({
  models: [DocumentSection],
  uri: TEST_APP_CONFIG.mongo.uri,
});

describe('documentSection.repository', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('inserts sections and soft-deletes by version and path', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();

    expect(
      await insertDocumentSections({
        orgId,
        projectId,
        sourceVersionId,
        path: 'docs/a.md',
        sections: [],
      }),
    ).toBe(0);
    expect(
      await insertDocumentSections({
        orgId,
        projectId,
        sourceVersionId,
        path: 'docs/a.md',
        sections: /** @type {any} */ (null),
      }),
    ).toBe(0);

    await insertDocumentSections({
      orgId,
      projectId,
      sourceVersionId,
      path: 'docs/a.md',
      sections: [
        {
          heading: 'A',
          startLine: 1,
          endLine: 2,
          text: 'hello',
          sectionIndex: 0,
        },
      ],
    });
    expect(await countSectionsForVersion({ orgId, projectId, sourceVersionId })).toBe(1);
    const listed = await listSectionsForVersion({ orgId, projectId, sourceVersionId });
    expect(listed).toHaveLength(1);
    expect(listed[0].path).toBe('docs/a.md');

    await softDeleteSectionsForPath({
      orgId,
      projectId,
      sourceVersionId,
      path: 'docs/a.md',
    });
    expect(await listSectionsForPath({ orgId, projectId, sourceVersionId, path: 'docs/a.md' })).toEqual(
      [],
    );

    await insertDocumentSections({
      orgId,
      projectId,
      sourceVersionId,
      path: 'docs/a.md',
      sections: [
        {
          heading: 'A2',
          startLine: 1,
          endLine: 3,
          text: 'again',
          sectionIndex: 0,
        },
      ],
    });
    await softDeleteSectionsForVersion({ orgId, projectId, sourceVersionId });
    expect(await countSectionsForVersion({ orgId, projectId, sourceVersionId })).toBe(0);
  });

  it('copies sections onto a new version and skips paths already present', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const fromSourceVersionId = new mongoose.Types.ObjectId();
    const toSourceVersionId = new mongoose.Types.ObjectId();

    await insertDocumentSections({
      orgId,
      projectId,
      sourceVersionId: fromSourceVersionId,
      path: 'docs/a.md',
      sections: [
        {
          heading: 'A',
          startLine: 1,
          endLine: 2,
          text: 'hello',
          sectionIndex: 0,
        },
      ],
    });

    expect(
      await copySectionsForPaths({
        orgId,
        projectId,
        fromSourceVersionId,
        toSourceVersionId,
        paths: [],
      }),
    ).toBe(0);

    expect(
      await copySectionsForPaths({
        orgId,
        projectId,
        fromSourceVersionId,
        toSourceVersionId,
        paths: ['docs/a.md'],
      }),
    ).toBe(1);
    expect(
      await listSectionsForPath({
        orgId,
        projectId,
        sourceVersionId: toSourceVersionId,
        path: 'docs/a.md',
      }),
    ).toHaveLength(1);

    expect(
      await copySectionsForPaths({
        orgId,
        projectId,
        fromSourceVersionId,
        toSourceVersionId,
        paths: ['docs/a.md'],
      }),
    ).toBe(0);
  });

  it('searches sections by text and loads one by id', async () => {
    const orgId = new mongoose.Types.ObjectId();
    const projectId = new mongoose.Types.ObjectId();
    const sourceVersionId = new mongoose.Types.ObjectId();

    expect(
      await searchDocumentSections({ orgId, projectId, sourceVersionId }, { q: '   ', limit: 5 }),
    ).toEqual([]);

    await insertDocumentSections({
      orgId,
      projectId,
      sourceVersionId,
      path: 'docs/refunds.md',
      sections: [
        {
          heading: 'Refunds',
          startLine: 1,
          endLine: 4,
          text: 'Partial refunds are allowed within thirty days.',
          sectionIndex: 0,
        },
      ],
    });
    const listed = await listSectionsForPath({
      orgId,
      projectId,
      sourceVersionId,
      path: 'docs/refunds.md',
    });
    const hits = await searchDocumentSections(
      { orgId, projectId, sourceVersionId },
      { q: 'refunds', limit: 5 },
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe('docs/refunds.md');

    const found = await findDocumentSectionById({
      orgId,
      projectId,
      sourceVersionId,
      sectionId: listed[0]._id,
    });
    expect(found?.heading).toBe('Refunds');
    expect(
      await findDocumentSectionById({
        orgId,
        projectId,
        sourceVersionId,
        sectionId: 'not-an-id',
      }),
    ).toBeNull();
  });
});
