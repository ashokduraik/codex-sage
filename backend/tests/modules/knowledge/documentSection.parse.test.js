/**
 * Unit tests for Markdown/MDX/plain-text document section splitting.
 */
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_SECTION_MAX_CHARS,
  DOCUMENT_TXT_SECTION_LINE_WINDOW,
  capSectionText,
  isDocumentPath,
  parseDocumentSections,
} from '../../../src/modules/knowledge/documents.js';

describe('isDocumentPath', () => {
  it('accepts md, mdx, and txt only', () => {
    expect(isDocumentPath('docs/a.md')).toBe(true);
    expect(isDocumentPath('x.MDX')).toBe(true);
    expect(isDocumentPath('notes.txt')).toBe(true);
    expect(isDocumentPath('src/a.js')).toBe(false);
  });
});

describe('parseDocumentSections', () => {
  it('returns ordered heading sections with line ranges for Markdown', () => {
    const content = ['# Intro', 'hello', '', '## Details', 'more', 'text'].join('\n');
    const sections = parseDocumentSections({ path: 'docs/guide.md', content });
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      heading: 'Intro',
      startLine: 1,
      endLine: 3,
      sectionIndex: 0,
    });
    expect(sections[0].text).toContain('hello');
    expect(sections[1]).toMatchObject({
      heading: 'Details',
      startLine: 4,
      endLine: 6,
      sectionIndex: 1,
    });
  });

  it('treats MDX the same as Markdown for ATX headings', () => {
    const content = ['# Title', '<Button />', 'body'].join('\n');
    const sections = parseDocumentSections({ path: 'page.mdx', content });
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Title');
    expect(sections[0].text).toContain('<Button />');
  });

  it('creates one section when Markdown has no headings', () => {
    const sections = parseDocumentSections({
      path: 'notes.md',
      content: 'plain paragraph\nsecond line',
    });
    expect(sections).toEqual([
      expect.objectContaining({
        heading: null,
        startLine: 1,
        endLine: 2,
        sectionIndex: 0,
      }),
    ]);
  });

  it('splits plain text into fixed line windows', () => {
    const lines = Array.from({ length: DOCUMENT_TXT_SECTION_LINE_WINDOW + 5 }, (_, i) => `L${i + 1}`);
    const sections = parseDocumentSections({
      path: 'notes.txt',
      content: lines.join('\n'),
    });
    expect(sections).toHaveLength(2);
    expect(sections[0].startLine).toBe(1);
    expect(sections[0].endLine).toBe(DOCUMENT_TXT_SECTION_LINE_WINDOW);
    expect(sections[1].startLine).toBe(DOCUMENT_TXT_SECTION_LINE_WINDOW + 1);
    expect(sections[1].endLine).toBe(DOCUMENT_TXT_SECTION_LINE_WINDOW + 5);
  });

  it('returns zero sections for non-doc extensions', () => {
    expect(parseDocumentSections({ path: 'src/a.js', content: '# not a doc' })).toEqual([]);
  });

  it('caps section text at DOCUMENT_SECTION_MAX_CHARS', () => {
    const huge = 'x'.repeat(DOCUMENT_SECTION_MAX_CHARS + 100);
    const sections = parseDocumentSections({ path: 'big.md', content: huge });
    expect(sections[0].text).toHaveLength(DOCUMENT_SECTION_MAX_CHARS);
    expect(capSectionText(huge)).toHaveLength(DOCUMENT_SECTION_MAX_CHARS);
  });

  it('keeps a non-empty preface before the first heading as its own section', () => {
    const content = ['preface line', '', '# Title', 'body'].join('\n');
    const sections = parseDocumentSections({ path: 'docs/pre.md', content });
    expect(sections[0]).toMatchObject({
      heading: null,
      startLine: 1,
      endLine: 2,
      sectionIndex: 0,
    });
    expect(sections[1].heading).toBe('Title');
  });

  it('handles empty Markdown and non-string content safely', () => {
    expect(parseDocumentSections({ path: 'empty.md', content: '' })).toEqual([
      expect.objectContaining({ heading: null, startLine: 1, endLine: 1, text: '', sectionIndex: 0 }),
    ]);
    expect(parseDocumentSections({ path: 'x.md', content: /** @type {any} */ (null) })).toEqual([
      expect.objectContaining({ text: '' }),
    ]);
    expect(capSectionText(/** @type {any} */ (null))).toBe('');
    expect(isDocumentPath(/** @type {any} */ (null))).toBe(false);
  });

  it('returns an empty insert count when sections array is empty', async () => {
    // Covered in repository.test; parse returns [] for non-docs already.
    expect(parseDocumentSections({ path: 'a.js', content: 'x' })).toEqual([]);
  });
});
