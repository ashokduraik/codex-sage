/**
 * DTO mapping for knowledge browse responses.
 */
import { KNOWLEDGE_SUMMARY_MAX_CHARS } from './knowledge.constants.js';

/**
 * Builds the shared browse envelope.
 * @param {'ready' | 'updating' | 'unavailable'} state Gate wrapper state.
 * @param {{
 *   knowledgeVersionId?: string | null,
 *   knowledgeHealth?: string | null,
 * }} [base] Shared fields.
 * @returns {object}
 */
export function emptyBrowseEnvelope(state, base = {}) {
  return {
    state,
    knowledgeVersionId: base.knowledgeVersionId ?? null,
    knowledgeHealth: base.knowledgeHealth ?? null,
    facets: [],
    items: [],
    cursor: null,
    summary: '',
    capabilities: [],
    title: '',
    dimensions: {},
    partialKnowledge: { excludedFromGraphCount: 0 },
  };
}

/**
 * Facets that have data. Empty categories are omitted (explorer §71).
 * @param {{
 *   hasSummary?: boolean,
 *   hasWorkflows?: boolean,
 *   hasApis?: boolean,
 *   hasSymbols?: boolean,
 *   hasDocumentation?: boolean,
 * }} flags Availability flags.
 * @returns {Array<{ key: string, available: true }>}
 */
export function mapBrowseFacets(flags) {
  /** @type {Array<{ key: string, available: true }>} */
  const facets = [];
  if (flags.hasSummary) {
    facets.push({ key: 'summary', available: true });
  }
  if (flags.hasWorkflows) {
    facets.push({ key: 'workflows', available: true });
  }
  if (flags.hasApis) {
    facets.push({ key: 'apis', available: true });
  }
  if (flags.hasSymbols) {
    facets.push({ key: 'symbols', available: true });
  }
  if (flags.hasDocumentation) {
    facets.push({ key: 'documentation', available: true });
  }
  return facets;
}

/**
 * Maps a CodeGraph symbol/search hit to a browse item.
 * @param {object} raw Library node or search result.
 * @returns {object | null}
 */
export function mapSymbolItem(raw) {
  const node = raw?.node && typeof raw.node === 'object' ? raw.node : raw;
  if (!node || typeof node !== 'object') {
    return null;
  }
  const name = typeof node.name === 'string' ? node.name : null;
  const path = typeof node.filePath === 'string' ? node.filePath : null;
  if (!name || !path) {
    return null;
  }
  const startLine = Number(node.startLine) || null;
  const endLine = Number(node.endLine) || startLine;
  return {
    id: typeof node.id === 'string' ? node.id : `${path}:${name}:${startLine ?? 0}`,
    name,
    kind: typeof node.kind === 'string' ? node.kind : 'symbol',
    path,
    line: startLine,
    sourceRef: { path, startLine, endLine },
  };
}

/**
 * Maps a routing-manifest entry or route node to an API item.
 * @param {object} raw Library row.
 * @param {number} index Fallback id salt.
 * @returns {object | null}
 */
export function mapApiItem(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.url === 'string') {
    return {
      id: `api:${raw.url}:${raw.handler ?? index}`,
      title: raw.url,
      description: typeof raw.handler === 'string' ? raw.handler : undefined,
      sourceRefs: raw.handlerFile
        ? [{ path: raw.handlerFile, startLine: Number(raw.handlerLine) || null, kind: 'code' }]
        : [],
    };
  }
  const path = typeof raw.filePath === 'string' ? raw.filePath : null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  if (!path || !name) {
    return null;
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : `api:${path}:${name}`,
    title: name,
    sourceRefs: [{ path, startLine: Number(raw.startLine) || null, kind: 'code' }],
  };
}

/**
 * Caps extractive summary text.
 * @param {string} text Raw joined text.
 * @returns {string}
 */
export function capSummaryText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  if (text.length <= KNOWLEDGE_SUMMARY_MAX_CHARS) {
    return text;
  }
  return text.slice(0, KNOWLEDGE_SUMMARY_MAX_CHARS);
}

/**
 * Builds an extractive summary from docs + graph metadata (no LLM).
 * @param {{
 *   projectName?: string,
 *   stats?: { fileCount?: number, nodeCount?: number } | null,
 *   frameworks?: string[],
 *   sections?: Array<{ heading?: string | null, text?: string, path?: string }>,
 * }} input Source fragments.
 * @returns {string}
 */
export function buildExtractiveSummary(input) {
  const parts = [];
  if (input.projectName) {
    parts.push(input.projectName);
  }
  const fileCount = Number(input.stats?.fileCount);
  const nodeCount = Number(input.stats?.nodeCount);
  if (Number.isFinite(fileCount) && fileCount > 0) {
    parts.push(`${fileCount} indexed files`);
  }
  if (Number.isFinite(nodeCount) && nodeCount > 0) {
    parts.push(`${nodeCount} graph nodes`);
  }
  if (Array.isArray(input.frameworks) && input.frameworks.length > 0) {
    parts.push(`Detected: ${input.frameworks.join(', ')}`);
  }
  for (const section of input.sections ?? []) {
    const heading = typeof section.heading === 'string' ? section.heading.trim() : '';
    const text = typeof section.text === 'string' ? section.text.trim() : '';
    if (heading) {
      parts.push(heading);
    }
    if (text) {
      parts.push(text);
    }
  }
  return capSummaryText(parts.filter(Boolean).join('\n\n'));
}

/**
 * Honest health dimensions — no fabricated documentation score.
 * @param {{
 *   hasSource: boolean,
 *   publishedHealth?: string | null,
 *   excludedFromGraphCount: number,
 * }} input Facts.
 * @returns {object}
 */
export function mapHealthDimensions(input) {
  return {
    sourceCode: {
      state: input.hasSource ? 'present' : 'absent',
      detail: null,
    },
    publishedHealth: {
      state: input.publishedHealth || 'none',
      detail: null,
    },
    exclusions: {
      state: input.excludedFromGraphCount > 0 ? 'partial' : 'none',
      detail:
        input.excludedFromGraphCount > 0
          ? `${input.excludedFromGraphCount} files are not in the code map`
          : null,
    },
  };
}
