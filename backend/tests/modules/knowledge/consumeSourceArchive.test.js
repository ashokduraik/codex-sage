/**
 * Unit tests for multipart archive consumption preHandler.
 */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { UPLOAD_MAX_ARCHIVE_BYTES } from '../../../src/modules/knowledge/uploads.js';
import { consumeSourceArchivePreHandler } from '../../../src/modules/knowledge/uploads.js';

/**
 * Builds a `request.parts` mock that yields the given multipart parts.
 * @param {Array<object>} multipartParts Multipart part objects.
 * @returns {() => AsyncGenerator}
 */
function partsIterable(multipartParts) {
  return async function* requestParts() {
    for (const part of multipartParts) {
      yield part;
    }
  };
}

describe('consumeSourceArchivePreHandler', () => {
  it('no-ops when the route is not opted in', async () => {
    const request = { routeOptions: { config: {} } };
    await consumeSourceArchivePreHandler(request);
    expect(request.sourceUpload).toBeUndefined();
  });

  it('reads projectId and archive parts and sets both on the body', async () => {
    const bytes = Buffer.from('zip-bytes');
    const projectId = '665f1c9d4b2a8e0012a4f001';
    const request = {
      routeOptions: { config: { consumeSourceArchive: true } },
      parts: partsIterable([
        { type: 'field', fieldname: 'projectId', value: projectId },
        {
          type: 'file',
          fieldname: 'archive',
          filename: 'a.zip',
          file: Readable.from([bytes]),
        },
      ]),
    };

    await consumeSourceArchivePreHandler(request);

    expect(request.sourceUpload.buffer.equals(bytes)).toBe(true);
    expect(request.sourceUpload.contentSha256).toHaveLength(64);
    expect(request.body).toEqual({
      projectId,
      archiveSha256: request.sourceUpload.contentSha256,
    });
  });

  it('rejects when projectId is missing', async () => {
    const request = {
      routeOptions: { config: { consumeSourceArchive: true } },
      parts: partsIterable([
        {
          type: 'file',
          fieldname: 'archive',
          filename: 'a.zip',
          file: Readable.from([Buffer.from('zip')]),
        },
      ]),
    };
    await expect(consumeSourceArchivePreHandler(request)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects when the archive field is missing', async () => {
    const request = {
      routeOptions: { config: { consumeSourceArchive: true } },
      parts: partsIterable([{ type: 'field', fieldname: 'projectId', value: '665f1c9d4b2a8e0012a4f001' }]),
    };
    await expect(consumeSourceArchivePreHandler(request)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects when the archive exceeds the size cap', async () => {
    const huge = Buffer.alloc(UPLOAD_MAX_ARCHIVE_BYTES + 1, 1);
    const request = {
      routeOptions: { config: { consumeSourceArchive: true } },
      parts: partsIterable([
        { type: 'field', fieldname: 'projectId', value: '665f1c9d4b2a8e0012a4f001' },
        {
          type: 'file',
          fieldname: 'archive',
          filename: 'huge.zip',
          file: Readable.from([huge]),
        },
      ]),
    };
    await expect(consumeSourceArchivePreHandler(request)).rejects.toMatchObject({
      code: 'SOURCE_ARCHIVE_TOO_LARGE',
    });
  });
});
