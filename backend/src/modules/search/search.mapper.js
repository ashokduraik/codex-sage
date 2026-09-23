/**
 * Maps document and CodeGraph hits to unified search items.
 */
import {
  encodeOpaqueKey,
  encodeSearchResultId,
  truncateSnippet,
} from './search.ids.js';

/**
 * Unwraps a CodeGraph search hit that may nest the node.
 * @param {object} raw Library row.
 * @returns {object | null}
 */
export function unwrapGraphNode(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const node = raw.node && typeof raw.node === 'object' ? raw.node : raw;
  return node && typeof node === 'object' ? node : null;
}

/**
 * True when a graph node is a file-like row (not a symbol).
 * @param {object | null} node Graph node.
 * @returns {boolean}
 */
export function isFileLikeNode(node) {
  if (!node) {
    return false;
  }
  const kind = typeof node.kind === 'string' ? node.kind.toLowerCase() : '';
  return kind === 'file' || kind === 'module' || kind === 'sourcefile';
}

/**
 * Maps a document section FTS row to a search item.
 * @param {object} section Lean DocumentSection.
 * @param {string} knowledgeVersionId Current version id.
 * @returns {object | null}
 */
export function mapDocSearchItem(section, knowledgeVersionId) {
  if (!section || typeof section !== 'object') {
    return null;
  }
  const path = typeof section.path === 'string' ? section.path : null;
  const sectionId = section._id ? String(section._id) : null;
  if (!path || !sectionId) {
    return null;
  }
  const title =
    typeof section.heading === 'string' && section.heading.trim()
      ? section.heading.trim()
      : path;
  return {
    id: encodeSearchResultId(knowledgeVersionId, 'doc', sectionId),
    type: 'doc',
    title,
    snippet: truncateSnippet(section.text),
    sourceRef: {
      path,
      startLine: Number(section.startLine) || undefined,
      endLine: Number(section.endLine) || undefined,
      sectionId,
    },
    score: null,
  };
}

/**
 * Maps a symbol/code graph node to a search item.
 * @param {object} raw Library row.
 * @param {string} knowledgeVersionId Current version id.
 * @param {'symbol' | 'code'} type Result type.
 * @returns {object | null}
 */
export function mapGraphSearchItem(raw, knowledgeVersionId, type) {
  const node = unwrapGraphNode(raw);
  if (!node) {
    return null;
  }
  const name = typeof node.name === 'string' ? node.name : null;
  const path = typeof node.filePath === 'string' ? node.filePath : null;
  if (!name || !path) {
    return null;
  }
  const startLine = Number(node.startLine) || 0;
  const endLine = Number(node.endLine) || startLine || undefined;
  const opaqueKey = encodeOpaqueKey([path, name, startLine]);
  const snippetSource =
    typeof raw.snippet === 'string'
      ? raw.snippet
      : typeof node.signature === 'string'
        ? node.signature
        : name;
  return {
    id: encodeSearchResultId(knowledgeVersionId, type, opaqueKey),
    type,
    title: name,
    snippet: truncateSnippet(snippetSource),
    sourceRef: {
      path,
      startLine: startLine || undefined,
      endLine: endLine || undefined,
    },
    score: null,
  };
}

/**
 * Maps a routing-manifest or route node to a search item.
 * @param {object} raw Library row.
 * @param {string} knowledgeVersionId Current version id.
 * @param {number} index Fallback salt.
 * @returns {object | null}
 */
export function mapApiSearchItem(raw, knowledgeVersionId, index) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.url === 'string') {
    const path = typeof raw.handlerFile === 'string' ? raw.handlerFile : '';
    const startLine = Number(raw.handlerLine) || 0;
    const title = raw.url;
    return {
      id: encodeSearchResultId(
        knowledgeVersionId,
        'api',
        encodeOpaqueKey([title, path, startLine, raw.handler ?? index]),
      ),
      type: 'api',
      title,
      snippet: truncateSnippet(typeof raw.handler === 'string' ? raw.handler : title),
      sourceRef: path
        ? { path, startLine: startLine || undefined }
        : { path: title },
      score: null,
    };
  }
  const path = typeof raw.filePath === 'string' ? raw.filePath : null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!path || !name) {
    return null;
  }
  const startLine = Number(raw.startLine) || 0;
  return {
    id: encodeSearchResultId(knowledgeVersionId, 'api', encodeOpaqueKey([name, path, startLine])),
    type: 'api',
    title: name,
    snippet: truncateSnippet(name),
    sourceRef: { path, startLine: startLine || undefined },
    score: null,
  };
}

/**
 * Maps a workflow node when the library exposes one.
 * @param {object} raw Library row.
 * @param {string} knowledgeVersionId Current version id.
 * @param {number} index Fallback salt.
 * @returns {object | null}
 */
export function mapWorkflowSearchItem(raw, knowledgeVersionId, index) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const title =
    typeof raw.title === 'string'
      ? raw.title
      : typeof raw.name === 'string'
        ? raw.name
        : null;
  const path =
    typeof raw.path === 'string'
      ? raw.path
      : typeof raw.filePath === 'string'
        ? raw.filePath
        : '';
  if (!title) {
    return null;
  }
  const startLine = Number(raw.startLine) || 0;
  return {
    id: encodeSearchResultId(
      knowledgeVersionId,
      'workflow',
      encodeOpaqueKey([title, path, startLine, raw.id ?? index]),
    ),
    type: 'workflow',
    title,
    snippet: truncateSnippet(typeof raw.description === 'string' ? raw.description : title),
    sourceRef: path ? { path, startLine: startLine || undefined } : { path: title },
    score: null,
  };
}

/**
 * True when an API/workflow title or path matches the query.
 * @param {object} item Mapped or raw row.
 * @param {string} query Search string.
 * @returns {boolean}
 */
export function matchesQueryText(item, query) {
  const needle = query.toLowerCase();
  const haystacks = [
    item.title,
    item.name,
    item.url,
    item.path,
    item.filePath,
    item.handlerFile,
    item.handler,
    item.description,
  ];
  return haystacks.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

/**
 * Builds a resolver evidence object from a search item.
 * @param {object} item Search item.
 * @returns {{ type: string, title: string, sourceRef: object, excerpt: string }}
 */
export function toResolverEvidence(item) {
  return {
    type: item.type,
    title: item.title,
    sourceRef: item.sourceRef,
    excerpt: item.snippet,
  };
}
