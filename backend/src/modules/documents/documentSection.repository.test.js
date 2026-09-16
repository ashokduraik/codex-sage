/**
 * Integration tests for DocumentSection repository soft-delete and insert.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../test/mongoHarness.js';
import { TEST_APP_CONFIG } from '../../test/appConfig.js';
import { DocumentSection } from './documentSection.model.js';
import {
  countSectionsForVersion,
  insertDocumentSections,
  listSectionsForPath,
  softDeleteSectionsForPath,
  softDeleteSectionsForVersion,
} from './documentSection.repository.js';

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
});
