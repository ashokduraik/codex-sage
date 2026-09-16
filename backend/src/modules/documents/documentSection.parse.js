/**
 * Split Markdown/MDX/plain-text into bounded DocumentSection DTOs.
 *
 * Uses an ATX-heading line scanner rather than unified/remark: those packages'
 * latest publishes were outside the project's 12-month maintenance gate
 * (dependency-versions.mdc). Heading grain matches the Phase 26 plan.
 */

/** Maximum searchable characters stored per section. */
export const DOCUMENT_SECTION_MAX_CHARS = 8000;

/** Line window size for plain-text (.txt) files. */
export const DOCUMENT_TXT_SECTION_LINE_WINDOW = 80;

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * @typedef {{
 *   heading: string | null,
 *   startLine: number,
 *   endLine: number,
 *   text: string,
 *   sectionIndex: number,
 * }} DocumentSectionDto
 */

/**
 * Returns true when the path is a documentation extension supported for FTS.
 * @param {string} filePath Repo-relative path.
 * @returns {boolean}
 */
export function isDocumentPath(filePath) {
  const lower = String(filePath ?? '').toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.txt');
}

/**
 * Caps section text to DOCUMENT_SECTION_MAX_CHARS.
 * @param {string} text Raw section text.
 * @returns {string}
 */
export function capSectionText(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= DOCUMENT_SECTION_MAX_CHARS) {
    return value;
  }
  return value.slice(0, DOCUMENT_SECTION_MAX_CHARS);
}

/**
 * Parses file contents into ordered section DTOs.
 * @param {{ path: string, content: string }} input Path + UTF-8 content.
 * @returns {DocumentSectionDto[]}
 */
export function parseDocumentSections(input) {
  const filePath = String(input.path ?? '');
  const content = typeof input.content === 'string' ? input.content : '';
  if (!isDocumentPath(filePath)) {
    return [];
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.txt')) {
    return splitPlainTextWindows(content);
  }
  return splitMarkdownByHeadings(content);
}

/**
 * Splits Markdown/MDX on ATX headings; no heading → one section for the file.
 * @param {string} content File text.
 * @returns {DocumentSectionDto[]}
 */
function splitMarkdownByHeadings(content) {
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (lines.length === 0) {
    return [
      {
        heading: null,
        startLine: 1,
        endLine: 1,
        text: '',
        sectionIndex: 0,
      },
    ];
  }

  /** @type {Array<{ heading: string | null, startLine: number, lineStartIndex: number }>} */
  const markers = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = ATX_HEADING.exec(lines[i]);
    if (match) {
      markers.push({
        heading: match[2].trim() || null,
        startLine: i + 1,
        lineStartIndex: i,
      });
    }
  }

  if (markers.length === 0) {
    return [
      {
        heading: null,
        startLine: 1,
        endLine: lines.length,
        text: capSectionText(lines.join('\n')),
        sectionIndex: 0,
      },
    ];
  }

  /** @type {DocumentSectionDto[]} */
  const sections = [];

  // Preface before the first heading (only when non-empty).
  if (markers[0].lineStartIndex > 0) {
    const prefaceLines = lines.slice(0, markers[0].lineStartIndex);
    const prefaceText = prefaceLines.join('\n').trim();
    if (prefaceText.length > 0) {
      sections.push({
        heading: null,
        startLine: 1,
        endLine: markers[0].startLine - 1,
        text: capSectionText(prefaceLines.join('\n')),
        sectionIndex: 0,
      });
    }
  }

  for (let m = 0; m < markers.length; m += 1) {
    const start = markers[m].lineStartIndex;
    const endExclusive =
      m + 1 < markers.length ? markers[m + 1].lineStartIndex : lines.length;
    const slice = lines.slice(start, endExclusive);
    sections.push({
      heading: markers[m].heading,
      startLine: markers[m].startLine,
      endLine: endExclusive,
      text: capSectionText(slice.join('\n')),
      sectionIndex: sections.length,
    });
  }

  return sections;
}

/**
 * Splits plain text into fixed line windows.
 * @param {string} content File text.
 * @returns {DocumentSectionDto[]}
 */
function splitPlainTextWindows(content) {
  const lines = content.length === 0 ? [''] : content.split(/\r?\n/);
  /** @type {DocumentSectionDto[]} */
  const sections = [];
  for (let start = 0; start < lines.length; start += DOCUMENT_TXT_SECTION_LINE_WINDOW) {
    const endExclusive = Math.min(start + DOCUMENT_TXT_SECTION_LINE_WINDOW, lines.length);
    const slice = lines.slice(start, endExclusive);
    sections.push({
      heading: null,
      startLine: start + 1,
      endLine: endExclusive,
      text: capSectionText(slice.join('\n')),
      sectionIndex: sections.length,
    });
  }
  return sections;
}
