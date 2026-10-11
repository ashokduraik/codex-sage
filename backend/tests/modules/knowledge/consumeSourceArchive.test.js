/**
 * Unit tests for multipart archive consumption preHandler.
 */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_MAX_ARCHIVE_BYTES } from '../../../src/modules/knowledge/uploads.js';
import { consumeSourceArchivePreHandler } from '../../../src/modules/knowledge/uploads.js';

describe('consumeSourceArchivePreHandler', () => {
  it('no-ops when the route is not opted in', async () => {
    const request = { routeOptions: { config: {} } };
    await consumeSourceArchivePreHandler(request);
    expect(request.sourceUpload).toBeUndefined();
  });

  it('reads the archive part and sets archiveSha256 on the body', async () => {
    const bytes = Buffer.from('zip-bytes');
    const request = {
      routeOptions: { config: { consumeSourceArchive: true } },
      file: vi.fn(async () => ({
        fieldname: 'archive',
        filename: 'a.zip',
        file: Readable.from([bytes]),
      })),
    };

    await consumeSourceArchivePreHandler(request);

    expect(request.sourceUpload.buffer.equals(bytes)).toBe(true);
    expect(request.sourceUpload.contentSha256).toHaveLength(64);
    expect(request.body).toEqual({ archiveSha256: request.sourceUpload.contentSha256 });
  });

  it('rejects when the archive field is missing', async () => {
    const request = {
      routeOptions: { config: { consumeSourceArchive: true } },
      file: vi.fn(async () => null),
    };
    await expect(consumeSourceArchivePreHandler(request)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects when the archive exceeds the size cap', async () => {
    const huge = Buffer.alloc(UPLOAD_MAX_ARCHIVE_BYTES + 1, 1);
    const request = {
      routeOptions: { config: { consumeSourceArchive: true } },
      file: vi.fn(async () => ({
        fieldname: 'archive',
        filename: 'huge.zip',
        file: Readable.from([huge]),
      })),
    };
    await expect(consumeSourceArchivePreHandler(request)).rejects.toMatchObject({
      code: 'SOURCE_ARCHIVE_TOO_LARGE',
    });
  });
});
