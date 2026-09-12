/**
 * Unit tests for zip integrity / slip inspection.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * @param {string} name
 * @returns {Promise<Buffer>}
 */
async function readFixture(name) {
  return readFile(path.join(fixturesDir, name));
}

describe('inspectZip', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('./exclusions.constants.js');
    vi.doUnmock('yauzl');
  });

  it('lists normalized paths and sizes from a valid archive', async () => {
    const { inspectZip } = await import('./zipInspect.js');
    const result = await inspectZip(await readFixture('good.zip'));
    expect(result.integrity).toBe('ok');
    const paths = result.entries.map((entry) => entry.path).sort();
    expect(paths).toContain('src/a.js');
    expect(paths).toContain('node_modules/pkg/index.js');
    expect(paths).toContain('README.md');
  });

  it('accepts a readable stream of archive bytes', async () => {
    const { inspectZip } = await import('./zipInspect.js');
    const stream = createReadStream(path.join(fixturesDir, 'valid-small.zip'));
    const result = await inspectZip(stream);
    expect(result.entries.map((entry) => entry.path)).toEqual(['src/a.js']);
  });

  it('normalizes backslash paths from zip entries', async () => {
    const { inspectZip } = await import('./zipInspect.js');
    const result = await inspectZip(await readFixture('backslash.zip'));
    expect(result.entries.map((entry) => entry.path)).toEqual(['src/a.js']);
  });

  it('rejects zip-slip parent paths', async () => {
    const { inspectZip } = await import('./zipInspect.js');
    await expect(inspectZip(await readFixture('slip.zip'))).rejects.toMatchObject({
      code: 'SOURCE_ZIP_SLIP',
    });
  });

  it('rejects absolute paths', async () => {
    const { inspectZip } = await import('./zipInspect.js');
    await expect(inspectZip(await readFixture('abs.zip'))).rejects.toMatchObject({
      code: 'SOURCE_ZIP_SLIP',
    });
  });

  it('rejects duplicate normalized paths', async () => {
    const { inspectZip } = await import('./zipInspect.js');
    await expect(inspectZip(await readFixture('duplicate.zip'))).rejects.toMatchObject({
      code: 'SOURCE_ZIP_SLIP',
    });
  });

  it('rejects truncated archives as integrity failures', async () => {
    const { inspectZip } = await import('./zipInspect.js');
    await expect(inspectZip(await readFixture('truncated.zip'))).rejects.toMatchObject({
      code: 'SOURCE_ZIP_INTEGRITY',
    });
  });

  it('rejects buffers over the archive byte cap', async () => {
    vi.resetModules();
    vi.doMock('./exclusions.constants.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        UPLOAD_MAX_ARCHIVE_BYTES: 32,
        UPLOAD_MAX_ENTRY_COUNT: 100_000,
      };
    });
    const { inspectZip } = await import('./zipInspect.js');
    const buffer = await readFixture('good.zip');
    expect(buffer.length).toBeGreaterThan(32);
    await expect(inspectZip(buffer)).rejects.toMatchObject({
      code: 'SOURCE_ARCHIVE_TOO_LARGE',
    });
  });

  it('rejects streams that exceed the archive byte cap', async () => {
    vi.resetModules();
    vi.doMock('./exclusions.constants.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        UPLOAD_MAX_ARCHIVE_BYTES: 16,
        UPLOAD_MAX_ENTRY_COUNT: 100_000,
      };
    });
    const { inspectZip } = await import('./zipInspect.js');
    const stream = Readable.from([Buffer.alloc(20, 1)]);
    await expect(inspectZip(stream)).rejects.toMatchObject({
      code: 'SOURCE_ARCHIVE_TOO_LARGE',
    });
  });

  it('rejects archives with more entries than the entry-count cap', async () => {
    vi.resetModules();
    vi.doMock('./exclusions.constants.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        UPLOAD_MAX_ARCHIVE_BYTES: 524_288_000,
        UPLOAD_MAX_ENTRY_COUNT: 1,
      };
    });
    const { inspectZip } = await import('./zipInspect.js');
    await expect(inspectZip(await readFixture('good.zip'))).rejects.toMatchObject({
      code: 'SOURCE_ARCHIVE_TOO_LARGE',
    });
  });

  it('rejects non-buffer non-stream input as integrity failure', async () => {
    const { inspectZip } = await import('./zipInspect.js');
    await expect(inspectZip(/** @type {never} */ (42))).rejects.toMatchObject({
      code: 'SOURCE_ZIP_INTEGRITY',
      name: 'ApiError',
    });
  });

  it('accepts a Uint8Array archive and skips directory marker entries', async () => {
    const { inspectZip } = await import('./zipInspect.js');
    const bytes = new Uint8Array(await readFixture('with-dir.zip'));
    const result = await inspectZip(bytes);
    expect(result.entries.map((entry) => entry.path)).toEqual(['src/a.js']);
  });

  it('rejects Uint8Array archives over the byte cap', async () => {
    vi.resetModules();
    vi.doMock('./exclusions.constants.js', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        UPLOAD_MAX_ARCHIVE_BYTES: 8,
        UPLOAD_MAX_ENTRY_COUNT: 100_000,
      };
    });
    const { inspectZip } = await import('./zipInspect.js');
    const bytes = new Uint8Array(20);
    await expect(inspectZip(bytes)).rejects.toMatchObject({
      code: 'SOURCE_ARCHIVE_TOO_LARGE',
    });
  });

  it('rejects encrypted zip entries', async () => {
    vi.resetModules();
    vi.doMock('yauzl', () => ({
      fromBufferPromise: async () => ({
        eachEntry: async function* eachEntry() {
          yield {
            fileName: 'src/a.js',
            uncompressedSize: 1,
            generalPurposeBitFlag: 0x1,
          };
        },
        close() {},
      }),
    }));
    const { inspectZip } = await import('./zipInspect.js');
    await expect(inspectZip(await readFixture('valid-small.zip'))).rejects.toMatchObject({
      code: 'SOURCE_ZIP_INTEGRITY',
    });
  });

  it('maps yauzl invalid-filename errors to SOURCE_ZIP_SLIP', async () => {
    vi.resetModules();
    vi.doMock('yauzl', () => ({
      fromBufferPromise: async () => {
        throw new Error('invalid filename: ../x');
      },
    }));
    const { inspectZip } = await import('./zipInspect.js');
    await expect(inspectZip(await readFixture('valid-small.zip'))).rejects.toMatchObject({
      code: 'SOURCE_ZIP_SLIP',
    });
  });

  it('buffers non-Buffer stream chunks within the archive cap', async () => {
    vi.resetModules();
    vi.doUnmock('yauzl');
    const { inspectZip } = await import('./zipInspect.js');
    const fileBytes = await readFixture('valid-small.zip');
    const stream = Readable.from([Uint8Array.from(fileBytes)]);
    const result = await inspectZip(stream);
    expect(result.entries.map((entry) => entry.path)).toEqual(['src/a.js']);
  });
});
