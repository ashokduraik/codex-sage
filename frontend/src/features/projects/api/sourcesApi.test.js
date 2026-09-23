/**
 * Unit tests for source upload API mapping.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/api/apiUpload.js', () => ({
  apiUpload: vi.fn(),
}));

import { apiUpload } from '@/shared/api/apiUpload.js';
import { uploadProjectSource } from './sourcesApi.js';

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
      '/projects/p1/sources',
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
});
