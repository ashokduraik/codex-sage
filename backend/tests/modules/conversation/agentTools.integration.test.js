/**
 * Mongo integration tests for tenant-scoped document search via executeTool.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { DocumentSection } from '../../../src/models/documentSection.model.js';
import { insertDocumentSections } from '../../../src/modules/knowledge/documents.js';
import { createTokenizerAdapter, executeTool } from '../../../src/modules/conversation/index.js';

const harness = createMongoHarness({
  models: [DocumentSection],
  uri: TEST_APP_CONFIG.mongo.uri,
});

const MODEL = 'test-model';

/**
 * @returns {object}
 */
function budgetState() {
  return {
    modelArtifactRef: MODEL,
    options: {
      tokenizer: createTokenizerAdapter({
        countTokens: (text) => (String(text).trim() === '' ? 0 : String(text).trim().split(/\s+/).length),
        expectedArtifactId: MODEL,
      }),
      validatedContextCapacity: 10_000,
      reservedOutputTokens: 0,
    },
  };
}

describe('agentTools integration', () => {
  beforeAll(async () => {
    await harness.beforeAll();
  }, 60_000);

  afterEach(async () => {
    await harness.afterEach();
  });

  afterAll(async () => {
    await harness.afterAll();
  });

  it('search_documents returns only the caller tenant sections', async () => {
    const orgA = new mongoose.Types.ObjectId();
    const orgB = new mongoose.Types.ObjectId();
    const projectA = new mongoose.Types.ObjectId();
    const projectB = new mongoose.Types.ObjectId();
    const sourceA = new mongoose.Types.ObjectId();
    const sourceB = new mongoose.Types.ObjectId();

    await insertDocumentSections({
      orgId: orgA,
      projectId: projectA,
      sourceVersionId: sourceA,
      path: 'docs/a.md',
      sections: [{ heading: 'Alpha', startLine: 1, endLine: 2, text: 'Unique refunds policy for org A.', sectionIndex: 0 }],
    });
    await insertDocumentSections({
      orgId: orgB,
      projectId: projectB,
      sourceVersionId: sourceB,
      path: 'docs/b.md',
      sections: [{ heading: 'Beta', startLine: 1, endLine: 2, text: 'Unique refunds policy for org B.', sectionIndex: 0 }],
    });

    const result = await executeTool(
      {
        name: 'search_documents',
        args: { query: 'refunds' },
        scope: {
          orgId: String(orgA),
          projectId: String(projectA),
          knowledgeVersionId: 'kv1',
          workspaceRoot: '/tmp/workspaces',
        },
        budgetState: budgetState(),
      },
      {
        findProject: async () => ({
          status: 'A',
          orgId: String(orgA),
          currentKnowledgeVersionId: 'kv1',
        }),
        findKnowledgeVersion: async () => ({ sourceVersionId: sourceA }),
        resolveWorkspacePath: () => '/tmp/workspaces/o/p',
      },
    );

    expect(result.evidenceRecords.length).toBeGreaterThan(0);
    expect(result.evidenceRecords.every((row) => row.path === 'docs/a.md')).toBe(true);
    expect(result.evidenceRecords.some((row) => row.path === 'docs/b.md')).toBe(false);
  });
});
