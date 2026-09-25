/**
 * Stable search result ids and keyset cursors.
 */
/** Result snippet character cap. */
export const SEARCH_SNIPPET_MAX_CHARS = 280;

/** Sort order for merged results (type then title). */
export const SEARCH_TYPE_ORDER = Object.freeze(['code', 'doc', 'symbol', 'workflow', 'api']);

/**
 * Encodes a search result id for the current knowledge version.
 * @param {string} knowledgeVersionId Current knowledge version id.
 * @param {string} type Search type token.
 * @param {string} opaqueKey Type-specific lookup key.
 * @returns {string}
 */
export function encodeSearchResultId(knowledgeVersionId, type, opaqueKey) {
  return `${knowledgeVersionId}:${type}:${opaqueKey}`;
}

/**
 * Parses a search result id into version, type, and opaque key.
 * @param {unknown} resultId Stored result id.
 * @returns {{ knowledgeVersionId: string, type: string, opaqueKey: string } | null}
 */
export function parseSearchResultId(resultId) {
  if (typeof resultId !== 'string' || resultId.length === 0) {
    return null;
  }
  const firstSep = resultId.indexOf(':');
  const secondSep = resultId.indexOf(':', firstSep + 1);
  if (firstSep <= 0 || secondSep <= firstSep) {
    return null;
  }
  const knowledgeVersionId = resultId.slice(0, firstSep);
  const type = resultId.slice(firstSep + 1, secondSep);
  const opaqueKey = resultId.slice(secondSep + 1);
  if (!knowledgeVersionId || !type || !opaqueKey) {
    return null;
  }
  return { knowledgeVersionId, type, opaqueKey };
}

/**
 * Encodes path/name/line parts into an opaque key.
 * @param {Array<string | number | null | undefined>} parts Lookup parts.
 * @returns {string}
 */
export function encodeOpaqueKey(parts) {
  return parts.map((part) => encodeURIComponent(String(part ?? ''))).join('|');
}

/**
 * Decodes an opaque key back into parts.
 * @param {string} opaqueKey Encoded key.
 * @returns {string[]}
 */
export function decodeOpaqueKey(opaqueKey) {
  if (typeof opaqueKey !== 'string' || opaqueKey.length === 0) {
    return [];
  }
  return opaqueKey.split('|').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

/**
 * Truncates a snippet to the named character cap.
 * @param {unknown} text Candidate text.
 * @returns {string}
 */
export function truncateSnippet(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SEARCH_SNIPPET_MAX_CHARS) {
    return collapsed;
  }
  return collapsed.slice(0, SEARCH_SNIPPET_MAX_CHARS);
}

/**
 * Encodes a keyset cursor from the last returned item.
 * @param {{ type: string, title: string, id: string }} item Last item.
 * @returns {string}
 */
export function encodeSearchCursor(item) {
  return Buffer.from(
    JSON.stringify({ type: item.type, title: item.title, id: item.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes a keyset cursor.
 * @param {unknown} cursor Opaque cursor.
 * @returns {{ type: string, title: string, id: string } | null}
 */
export function decodeSearchCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed.type !== 'string' ||
      typeof parsed.title !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Compares two search items for type-then-title sort.
 * @param {{ type: string, title: string, id: string }} left Left item.
 * @param {{ type: string, title: string, id: string }} right Right item.
 * @returns {number}
 */
export function compareSearchItems(left, right) {
  const leftType = SEARCH_TYPE_ORDER.indexOf(left.type);
  const rightType = SEARCH_TYPE_ORDER.indexOf(right.type);
  if (leftType !== rightType) {
    return leftType - rightType;
  }
  const titleCmp = left.title.localeCompare(right.title);
  if (titleCmp !== 0) {
    return titleCmp;
  }
  return left.id.localeCompare(right.id);
}

/**
 * True when `item` sorts after the cursor (exclusive).
 * @param {{ type: string, title: string, id: string }} item Candidate.
 * @param {{ type: string, title: string, id: string } | null} cursor Decoded cursor.
 * @returns {boolean}
 */
export function isAfterSearchCursor(item, cursor) {
  if (!cursor) {
    return true;
  }
  return compareSearchItems(item, cursor) > 0;
}
