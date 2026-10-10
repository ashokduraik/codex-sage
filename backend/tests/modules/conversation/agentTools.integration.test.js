/**
 * Mongo integration tests for tenant-scoped document search via executeTool.
 * Scope seams are mocked; searchDocumentSections and Mongo stay real.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

vi.mock('../../../src/modules/masters/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findProjectById: vi.fn(),
  };
});

vi.mock('../../../src/modules/knowledge/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findKnowledgeVersionById: vi.fn(),
    resolveProjectWorkspacePath: vi.fn(),
  };
});

import { createMongoHarness } from '../../mongoHarness.js';
import { TEST_APP_CONFIG } from '../../appConfig.js';
import { DocumentSection } from '../../../src/models/documentSection.model.js';
import { insertDocumentSections } from '../../../src/modules/knowledge/documents.js';
import { findProjectById } from '../../../src/modules/masters/index.js';
import { findKnowledgeVersionById, resolveProjectWorkspacePath } from '../../../src/modules/knowledge/index.js';
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

  beforeEach(() => {
    vi.clearAllMocks();
    resolveProjectWorkspacePath.mockReturnValue('/tmp/workspaces/o/p');
  });

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

    findProjectById.mockResolvedValue({
      status: 'A',
      orgId: String(orgA),
      currentKnowledgeVersionId: 'kv1',
    });
    findKnowledgeVersionById.mockResolvedValue({ sourceVersionId: sourceA });

    const result = await executeTool({
      name: 'search_documents',
      args: { query: 'refunds' },
      scope: {
        orgId: String(orgA),
        projectId: String(projectA),
        knowledgeVersionId: 'kv1',
        workspaceRoot: '/tmp/workspaces',
      },
      budgetState: budgetState(),
    });

    expect(result.evidenceRecords.length).toBeGreaterThan(0);
    expect(result.evidenceRecords.every((row) => row.path === 'docs/a.md')).toBe(true);
    expect(result.evidenceRecords.some((row) => row.path === 'docs/b.md')).toBe(false);
  });
});
