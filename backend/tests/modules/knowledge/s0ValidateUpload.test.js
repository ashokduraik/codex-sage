/**
 * Unit tests for S0 validate_upload unhappy paths (repository mocked).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSourceFilesOrdered = vi.fn();
const countSourceFilesForVersion = vi.fn();
const markSourceVersionFailed = vi.fn();

vi.mock('../../../src/modules/knowledge/ingest.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listSourceFilesOrdered: (...args) => listSourceFilesOrdered(...args),
    countSourceFilesForVersion: (...args) => countSourceFilesForVersion(...args),
    markSourceVersionFailed: (...args) => markSourceVersionFailed(...args),
  };
});

const { runValidateUploadStage } = await import('../../../src/modules/knowledge/ingest.helper.js');

describe('runValidateUploadStage', () => {
  beforeEach(() => {
    listSourceFilesOrdered.mockReset();
    countSourceFilesForVersion.mockReset();
    markSourceVersionFailed.mockReset().mockResolvedValue(undefined);
  });

  it('fails with SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS when no files remain', async () => {
    listSourceFilesOrdered.mockResolvedValue([]);
    const ctx = {
      scope: {
        orgId: '665f1c9d4b2a8e0012a4f001',
        projectId: '665f1c9d4b2a8e0012a4f002',
        sourceVersionId: '665f1c9d4b2a8e0012a4f003',
      },
      carry: {
        sourceVersion: {
          orgId: '665f1c9d4b2a8e0012a4f001',
          projectId: '665f1c9d4b2a8e0012a4f002',
          status: 'A',
          versionLifecycle: 'received',
          exclusionRulesetId: 'exclusions.v1',
        },
      },
      counters: { filesTotal: 0 },
      signal: { aborted: false },
      emitEvent: vi.fn().mockResolvedValue(undefined),
      saveProgress: vi.fn().mockResolvedValue(undefined),
    };

    await expect(runValidateUploadStage(ctx)).rejects.toMatchObject({
      code: 'SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS',
      failureClass: 'user_action_required',
    });
    expect(markSourceVersionFailed).toHaveBeenCalled();
  });

  it('fails with INGEST_TENANT_MISMATCH when version org differs', async () => {
    const ctx = {
      scope: {
        orgId: '665f1c9d4b2a8e0012a4f001',
        projectId: '665f1c9d4b2a8e0012a4f002',
        sourceVersionId: '665f1c9d4b2a8e0012a4f003',
      },
      carry: {
        sourceVersion: {
          orgId: '665f1c9d4b2a8e0012a4f099',
          projectId: '665f1c9d4b2a8e0012a4f002',
          status: 'A',
          versionLifecycle: 'received',
          exclusionRulesetId: 'exclusions.v1',
        },
      },
      counters: { filesTotal: 0 },
      signal: { aborted: false },
      emitEvent: vi.fn().mockResolvedValue(undefined),
      saveProgress: vi.fn().mockResolvedValue(undefined),
    };

    await expect(runValidateUploadStage(ctx)).rejects.toMatchObject({
      code: 'INGEST_TENANT_MISMATCH',
      failureClass: 'permanent',
    });
    expect(markSourceVersionFailed).toHaveBeenCalled();
  });
});
