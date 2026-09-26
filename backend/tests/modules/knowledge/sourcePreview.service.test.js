/**
 * Unit tests for source preview path safety, metadata, and slices.
 */
import { describe, expect, it } from 'vitest';
import {
  contentTypeForPath,
  countTextLines,
  createPreviewCaps,
  graphCoverageFromFile,
  isBinaryPreview,
  loadSourceFileMetadata,
  loadSourceFileSlice,
  normalizePreviewPath,
  sliceUtf8,
} from '../../../src/modules/knowledge/sourcePreview.js';

/**
 * @returns {object}
 */
function readyProject() {
  return { status: 'A', currentKnowledgeVersionId: 'kv1' };
}

describe('preview helpers', () => {
  it('rejects unsafe, empty, long, and NUL paths', () => {
    expect(normalizePreviewPath('src/a.js')).toBe('src/a.js');
    expect(normalizePreviewPath('./src\\a.js')).toBe('src/a.js');
    expect(() => normalizePreviewPath('../etc/passwd')).toThrow();
    expect(() => normalizePreviewPath('/etc/passwd')).toThrow();
    expect(() => normalizePreviewPath('a\0b')).toThrow();
    expect(() => normalizePreviewPath('')).toThrow();
    expect(() => normalizePreviewPath('x'.repeat(2000))).toThrow();
  });

  it('detects binary files and content types', () => {
    expect(contentTypeForPath('src/a.js')).toBe('text/javascript');
    expect(contentTypeForPath('a.json')).toBe('application/json');
    expect(contentTypeForPath('a.md')).toBe('text/markdown');
    expect(contentTypeForPath('a.css')).toBe('text/css');
    expect(contentTypeForPath('a.html')).toBe('text/html');
    expect(contentTypeForPath('a.png')).toBe('application/octet-stream');
    expect(contentTypeForPath('README')).toBe('text/plain');
    expect(isBinaryPreview('a.png', Buffer.from('abc'))).toBe(true);
    expect(isBinaryPreview('a.js', Buffer.from('abc\0def'))).toBe(true);
    expect(isBinaryPreview('a.js', Buffer.from('abc'))).toBe(false);
    expect(countTextLines(Buffer.from(''))).toBe(0);
    expect(countTextLines(Buffer.from('a\nb\n'))).toBe(3);
    expect(graphCoverageFromFile({ excludedFromGraph: true, exclusionReason: 'file_too_large' })).toEqual({
      excludedFromGraph: true,
      graphCoverage: { includedInGraph: false, reason: 'file_too_large' },
    });
    expect(graphCoverageFromFile({ excludedFromGraph: false }).graphCoverage.includedInGraph).toBe(true);
    expect(createPreviewCaps({ maxBytes: 10 }).maxBytes).toBe(10);
    const sliced = sliceUtf8(Buffer.from('hello world'), 5);
    expect(sliced.truncated).toBe(true);
    expect(sliced.text.length).toBeGreaterThan(0);
    expect(sliceUtf8(Buffer.from('hi'), 10).truncated).toBe(false);
  });
});

describe('loadSourceFileMetadata / loadSourceFileSlice', () => {
  it('throws PROJECT_NOT_FOUND or SOURCE_NOT_FOUND when scope is missing', async () => {
    await expect(loadSourceFileMetadata({ orgId: 'o1', projectId: 'p1', path: 'src/a.js' }, { findProject: async () => null })).rejects.toMatchObject(
      { code: 'PROJECT_NOT_FOUND' },
    );

    await expect(
      loadSourceFileMetadata(
        { orgId: 'o1', projectId: 'p1', path: 'src/a.js' },
        {
          findProject: async () => ({ status: 'A', currentKnowledgeVersionId: null }),
        },
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });

    await expect(
      loadSourceFileMetadata(
        { orgId: 'o1', projectId: 'p1', path: 'src/a.js' },
        {
          findProject: async () => readyProject(),
          findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
          findFile: async () => null,
        },
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });

  it('returns metadata including excluded-from-graph labels', async () => {
    const meta = await loadSourceFileMetadata(
      { orgId: 'o1', projectId: 'p1', path: 'src/a.js' },
      {
        findProject: async () => readyProject(),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        findFile: async () => ({
          path: 'src/a.js',
          sha256: 'abc',
          byteLength: 5,
          gridFsId: 'g1',
          excludedFromGraph: true,
          exclusionReason: 'over_graph_size_limit',
        }),
        readBytes: async () => Buffer.from('hello'),
      },
    );
    expect(meta).toMatchObject({
      path: 'src/a.js',
      sourceVersionId: 'sv1',
      knowledgeVersionId: 'kv1',
      previewAvailable: true,
      excludedFromGraph: true,
      graphCoverage: { includedInGraph: false, reason: 'over_graph_size_limit' },
      lineCount: 1,
      contentType: 'text/javascript',
    });
  });

  it('marks binary files as not previewable and rejects slices', async () => {
    const deps = {
      findProject: async () => readyProject(),
      findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
      findFile: async () => ({
        path: 'logo.png',
        sha256: 'x',
        byteLength: 4,
        gridFsId: 'g1',
        excludedFromGraph: false,
      }),
      readBytes: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    };
    const meta = await loadSourceFileMetadata({ orgId: 'o1', projectId: 'p1', path: 'logo.png' }, deps);
    expect(meta.previewAvailable).toBe(false);
    expect(meta.lineCount).toBeNull();
    await expect(loadSourceFileSlice({ orgId: 'o1', projectId: 'p1', path: 'logo.png', startLine: 1, endLine: 2 }, deps)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('slices lines and truncates when the byte cap is exceeded', async () => {
    const lines = ['one', 'two', 'three', 'four'];
    const result = await loadSourceFileSlice(
      { orgId: 'o1', projectId: 'p1', path: 'src/a.js', startLine: 2, endLine: 4 },
      {
        findProject: async () => readyProject(),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        findFile: async () => ({
          path: 'src/a.js',
          sha256: 'x',
          byteLength: 20,
          gridFsId: 'g1',
          excludedFromGraph: false,
        }),
        readBytes: async () => Buffer.from(lines.join('\n')),
        caps: { maxBytes: 5, maxLines: 400 },
      },
    );
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toBe('byte_cap');
    expect(result.startLine).toBe(2);
    expect(result.content.length).toBeLessThanOrEqual(5);
  });

  it('truncates by line cap and rejects invalid ranges', async () => {
    await expect(
      loadSourceFileSlice({
        orgId: 'o1',
        projectId: 'p1',
        path: 'src/a.js',
        startLine: 3,
        endLine: 1,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      loadSourceFileSlice(
        { orgId: 'o1', projectId: 'p1', path: 'src/a.js', startLine: 9, endLine: 10 },
        {
          findProject: async () => readyProject(),
          findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
          findFile: async () => ({
            path: 'src/a.js',
            sha256: 'x',
            byteLength: 5,
            gridFsId: 'g1',
            excludedFromGraph: false,
          }),
          readBytes: async () => Buffer.from('a\nb\n'),
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const capped = await loadSourceFileSlice(
      { orgId: 'o1', projectId: 'p1', path: 'src/a.js', startLine: 1, endLine: 4 },
      {
        findProject: async () => readyProject(),
        findKnowledgeVersion: async () => ({ sourceVersionId: 'sv1' }),
        findFile: async () => ({
          path: 'src/a.js',
          sha256: 'x',
          byteLength: 20,
          gridFsId: 'g1',
          excludedFromGraph: false,
        }),
        readBytes: async () => Buffer.from('a\nb\nc\nd'),
        caps: { maxBytes: 1000, maxLines: 2 },
      },
    );
    expect(capped.truncatedReason).toBe('line_cap');
    expect(capped.content.split('\n')).toHaveLength(2);
  });
});
