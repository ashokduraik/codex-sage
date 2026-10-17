/**
 * Unit tests for source upload API mapping.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/api/apiUpload.js', () => ({
  apiUpload: vi.fn(),
}));

vi.mock('@/shared/api/index', () => ({
  apiRequest: vi.fn(),
}));

import { apiRequest } from '@/shared/api/index';
import { apiUpload } from '@/shared/api/apiUpload.js';
import {
  uploadProjectSource,
  reingestProjectSource,
  sourceVersionsQueryKey,
  listProjectSourceVersions,
  SOURCE_VERSION_LIST_PAGE_SIZE,
} from '@/features/projects/api/sourcesApi.js';

describe('uploadProjectSource', () => {
  it('posts the archive field with an Idempotency-Key', async () => {
    apiUpload.mockResolvedValue({ sourceVersionId: 'sv1', jobId: 'j1' });
    const file = new File(['zip'], 'src.zip', { type: 'application/zip' });
    const onUploadProgress = vi.fn();
    await expect(
      uploadProjectSource({
        projectId: 'p1',
        file,
        idempotencyKey: 'idem-1',
        onUploadProgress,
      }),
    ).resolves.toEqual({ sourceVersionId: 'sv1', jobId: 'j1' });
    expect(apiUpload).toHaveBeenCalledWith(
      '/knowledge/uploads/upload/p1',
      expect.objectContaining({
        method: 'POST',
        idempotencyKey: 'idem-1',
        onUploadProgress,
      }),
    );
    const sent = apiUpload.mock.calls[0][1].body;
    const archive = sent.get('archive');
    expect(archive).toBeInstanceOf(File);
    expect(archive.name).toBe(file.name);
    expect(archive.size).toBe(file.size);
  });

  it('lists source versions with the default page size', async () => {
    apiRequest.mockResolvedValue({ items: [], pageInfo: { nextCursor: null, hasMore: false } });
    await listProjectSourceVersions({ projectId: 'p1' });
    expect(apiRequest).toHaveBeenCalledWith(`/knowledge/sources/listVersions/p1?limit=${SOURCE_VERSION_LIST_PAGE_SIZE}`, { signal: undefined });
    expect(sourceVersionsQueryKey('p1')).toEqual(['projects', 'p1', 'source-versions']);
  });

  it('posts reingest with an Idempotency-Key', async () => {
    apiRequest.mockResolvedValue({ jobId: 'j9', sourceVersionId: 'sv1', jobType: 'reingest' });
    await expect(
      reingestProjectSource({
        projectId: 'p1',
        sourceVersionId: 'sv1',
        idempotencyKey: 'idem-re',
      }),
    ).resolves.toEqual({ jobId: 'j9', sourceVersionId: 'sv1', jobType: 'reingest' });
    expect(apiRequest).toHaveBeenCalledWith('/knowledge/sources/reingest/p1/sv1', {
      method: 'POST',
      idempotencyKey: 'idem-re',
      signal: undefined,
    });
  });
});
