/**
 * Conversation context budgeter — measure assembled prompt segments with a
 * tokenizer that matches the live or injected artifact id, compact in
 * solution §1.2 order, and fail closed when counting is unavailable. No HTTP;
 * callers are future LLM / tool / loader code in this module.
 */
import { ApiError } from '../../platform/errors.js';

/**
 * Reserved completion tokens (DRAFT eval_count 201 + margin 256) from the
 * reviewed measurement run. Not env — compaction math, not a host connection.
 */
export const RESERVED_OUTPUT_TOKENS = 457;

/**
 * Floor when shrinking an excerpt so a source-id stub stays measurable.
 */
export const EXCERPT_MIN_TOKENS = 27;

/** Prevents an infinite shrink / drop loop. */
export const COMPACTION_MAX_PASSES = 8;

const SCHEMA_KINDS = new Set(['system', 'tool_schema']);
const TURN_KIND = 'turn';
const TOOL_RESULT_KIND = 'tool_result';
const SUMMARY_KIND = 'summary';

/**
 * Compaction constants plus caller-supplied capacity and live/injected artifact id.
 * @param {{ contextCapacity?: number, artifactId?: string }} llm Runtime llm slice.
 * @returns {{
 *   validatedContextCapacity: number,
 *   reservedOutputTokens: number,
 *   excerptMinTokens: number,
 *   compactionMaxPasses: number,
 *   artifactId: string,
 * }}
 * @throws When capacity or artifact id is missing.
 */
export function getContextBudgetConfig(llm) {
  const contextCapacity = llm?.contextCapacity;
  const artifactId = typeof llm?.artifactId === 'string' ? llm.artifactId.trim() : '';
  if (!Number.isFinite(contextCapacity) || contextCapacity <= 0 || !artifactId) {
    throwAccountingUnavailable('evaluation_config_missing');
  }
  return {
    validatedContextCapacity: contextCapacity,
    reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
    excerptMinTokens: EXCERPT_MIN_TOKENS,
    compactionMaxPasses: COMPACTION_MAX_PASSES,
    artifactId,
  };
}

/**
 * Throws the fail-closed accounting error (never returns guessed sizes).
 * @param {string} reason Machine-readable reason for logs / callers.
 * @returns {never}
 */
function throwAccountingUnavailable(reason) {
  throw ApiError.fromCode('CONTEXT_ACCOUNTING_UNAVAILABLE', {
    details: { reason },
  });
}

/**
 * Builds a tokenizer adapter. Production has no npm tokenizer until a package
 * proves parity with the evaluation fixtures — the default count function fails
 * closed. Tests inject `countTokens` / `assertArtifactMatch`.
 * @param {{
 *   countTokens?: (text: string) => number,
 *   assertArtifactMatch?: (modelArtifactId: string) => void,
 *   expectedArtifactId?: string,
 * }} [config] Optional seams.
 * @returns {{
 *   countTokens: (text: string) => number,
 *   countMessage: (message: { content?: string }) => number,
 *   assertArtifactMatch: (modelArtifactId: string) => void,
 * }}
 */
export function createTokenizerAdapter(config = {}) {
  const expectedArtifactId = typeof config.expectedArtifactId === 'string' ? config.expectedArtifactId.trim() : '';

  /**
   * @param {string} text Raw segment or message text.
   * @returns {number}
   */
  function countTokens(text) {
    if (config.countTokens) {
      return config.countTokens(text ?? '');
    }
    throwAccountingUnavailable('tokenizer_unavailable');
  }

  /**
   * @param {{ content?: string }} message Prompt part.
   * @returns {number}
   */
  function countMessage(message) {
    return countTokens(typeof message?.content === 'string' ? message.content : '');
  }

  /**
   * @param {string} modelArtifactId Model id from the caller.
   * @returns {void}
   */
  function assertArtifactMatch(modelArtifactId) {
    if (config.assertArtifactMatch) {
      config.assertArtifactMatch(modelArtifactId);
      return;
    }
    if (!expectedArtifactId || !modelArtifactId || String(modelArtifactId) !== String(expectedArtifactId)) {
      throwAccountingUnavailable('tokenizer_artifact_mismatch');
    }
  }

  return { countTokens, countMessage, assertArtifactMatch };
}

/**
 * @param {object} segment Prompt block.
 * @returns {boolean}
 */
function isProtectedSegment(segment) {
  return segment.protected === true;
}

/**
 * @param {object} segment Prompt block.
 * @returns {boolean}
 */
function isSchemaSegment(segment) {
  return SCHEMA_KINDS.has(segment.kind);
}

/**
 * @param {object} segment Prompt block.
 * @returns {boolean}
 */
function isUnprotectedTurn(segment) {
  return segment.kind === TURN_KIND && !isProtectedSegment(segment);
}

/**
 * Source-id stub kept when a tool body is dropped (solution §1.2 step 3).
 * @param {object} segment Tool result segment.
 * @returns {string}
 */
function buildToolSourceStub(segment) {
  const path = segment.path ?? '';
  const sourceId = segment.sourceId ?? '';
  return `[source: ${path} ${sourceId}]`.trim();
}

/**
 * @param {object} segment Tool result.
 * @returns {boolean}
 */
function isDroppableToolBody(segment) {
  return segment.kind === TOOL_RESULT_KIND && !isProtectedSegment(segment) && segment.stubbed !== true;
}

/**
 * @param {object} segment Candidate excerpt.
 * @returns {boolean}
 */
function isShrinkableExcerpt(segment) {
  if (isProtectedSegment(segment) || isSchemaSegment(segment) || isUnprotectedTurn(segment)) {
    return false;
  }
  return segment.kind === TOOL_RESULT_KIND || segment.kind === 'excerpt' || segment.shrinkable === true;
}

/**
 * Copies segments so compaction never mutates the caller’s array.
 * @param {object[]} segments Input blocks.
 * @returns {object[]}
 */
function cloneSegments(segments) {
  return (segments ?? []).map((segment) => ({ ...segment, content: segment.content ?? '' }));
}

/**
 * Tokens that compete for the input budget (everything except system / tool schema).
 * @param {object[]} segments Working set.
 * @param {(text: string) => number} countTokens Adapter.
 * @returns {number}
 */
function measureCompetingInput(segments, countTokens) {
  let total = 0;
  for (const segment of segments) {
    if (!isSchemaSegment(segment)) {
      total += countTokens(segment.content ?? '');
    }
  }
  return total;
}

/**
 * Tokens already reserved as system rules and tool-schema overhead.
 * @param {object[]} segments Working set.
 * @param {(text: string) => number} countTokens Adapter.
 * @param {number} toolSchemaTokenOverhead Caller-measured extra schema tokens.
 * @returns {number}
 */
function measureSystemAndToolSchema(segments, countTokens, toolSchemaTokenOverhead) {
  let total = Number.isFinite(toolSchemaTokenOverhead) ? toolSchemaTokenOverhead : 0;
  for (const segment of segments) {
    if (isSchemaSegment(segment)) {
      total += countTokens(segment.content ?? '');
    }
  }
  return total;
}

/**
 * Collapses the oldest unprotected turn (and its following turn mate when present)
 * into the caller-supplied summary. Returns whether an action ran.
 * @param {object[]} working Mutated working set.
 * @param {object | undefined} summarySegment Caller summary.
 * @param {object[]} compactionActions Audit log.
 * @param {(text: string) => number} countTokens Adapter.
 * @returns {boolean}
 */
function replaceOldestTurnsWithSummary(working, summarySegment, compactionActions, countTokens) {
  const firstTurnIndex = working.findIndex(isUnprotectedTurn);
  if (firstTurnIndex < 0) {
    return false;
  }
  const removed = [working[firstTurnIndex]];
  working.splice(firstTurnIndex, 1);
  if (working[firstTurnIndex] && isUnprotectedTurn(working[firstTurnIndex])) {
    removed.push(working[firstTurnIndex]);
    working.splice(firstTurnIndex, 1);
  }
  const beforeTokens = removed.reduce((sum, segment) => sum + countTokens(segment.content ?? ''), 0);
  const summaryAlreadyPresent = working.some((segment) => segment.kind === SUMMARY_KIND);
  let afterTokens = 0;
  if (summarySegment && !summaryAlreadyPresent) {
    const summaryCopy = { ...summarySegment, kind: SUMMARY_KIND, content: summarySegment.content ?? '' };
    const insertAt = working.findIndex((segment) => !isSchemaSegment(segment));
    working.splice(insertAt < 0 ? working.length : insertAt, 0, summaryCopy);
    afterTokens = countTokens(summaryCopy.content);
  }
  compactionActions.push({
    action: summarySegment && !summaryAlreadyPresent ? 'replace_with_summary' : 'drop_turn',
    segmentId: removed[0].id,
    beforeTokens,
    afterTokens,
  });
  return true;
}

/**
 * Drops the lowest-ranked unprotected tool body and keeps a source stub.
 * @param {object[]} working Mutated working set.
 * @param {object[]} compactionActions Audit log.
 * @param {(text: string) => number} countTokens Adapter.
 * @returns {boolean}
 */
function dropLowestRankedToolBody(working, compactionActions, countTokens) {
  const candidates = working.filter(isDroppableToolBody);
  if (candidates.length === 0) {
    return false;
  }
  candidates.sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0));
  const target = candidates[0];
  const beforeTokens = countTokens(target.content ?? '');
  target.content = buildToolSourceStub(target);
  target.stubbed = true;
  const afterTokens = countTokens(target.content);
  compactionActions.push({
    action: 'drop_tool_body',
    segmentId: target.id,
    beforeTokens,
    afterTokens,
  });
  return true;
}

/**
 * Shrinks one excerpt at a paragraph, then sentence, then word boundary.
 * @param {object[]} working Mutated working set.
 * @param {number} excerptMinTokens Floor.
 * @param {object[]} compactionActions Audit log.
 * @param {(text: string) => number} countTokens Adapter.
 * @returns {boolean}
 */
function shrinkOneExcerpt(working, excerptMinTokens, compactionActions, countTokens) {
  const target = working.find((segment) => isShrinkableExcerpt(segment) && countTokens(segment.content ?? '') > excerptMinTokens);
  if (!target) {
    return false;
  }
  const beforeTokens = countTokens(target.content ?? '');
  const nextContent = shrinkExcerptContent(target.content, excerptMinTokens, countTokens);
  if (nextContent === target.content) {
    return false;
  }
  target.content = nextContent;
  const afterTokens = countTokens(target.content);
  if (afterTokens >= beforeTokens) {
    return false;
  }
  compactionActions.push({
    action: 'shrink_excerpt',
    segmentId: target.id,
    beforeTokens,
    afterTokens,
  });
  return true;
}

/**
 * Reduces excerpt text at natural boundaries down toward the token floor.
 * @param {string} content Current excerpt.
 * @param {number} excerptMinTokens Floor.
 * @param {(text: string) => number} countTokens Adapter.
 * @returns {string}
 */
function shrinkExcerptContent(content, excerptMinTokens, countTokens) {
  const paragraphs = content.split(/\n\n+/);
  if (paragraphs.length > 1) {
    paragraphs.pop();
    return paragraphs.join('\n\n').trim();
  }
  const sentences = content.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1) {
    sentences.pop();
    return sentences.join(' ').trim();
  }
  const words = content.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return content;
  }
  let low = 1;
  let high = words.length - 1;
  let chosen = words.slice(0, high).join(' ');
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = words.slice(0, mid).join(' ');
    if (countTokens(candidate) >= excerptMinTokens) {
      chosen = candidate;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return chosen;
}

/**
 * Compacts in solution §1.2 order until the competing input fits or we must fail.
 * @param {object} args Compaction args.
 * @returns {object[]}
 */
function compactSegments(args) {
  const { working, summarySegment, countTokens, inputBudget, excerptMinTokens, compactionMaxPasses } = args;
  const compactionActions = [];
  let passes = 0;

  /**
   * @returns {boolean}
   */
  function isOverBudget() {
    return measureCompetingInput(working, countTokens) > inputBudget;
  }

  while (isOverBudget() && passes < compactionMaxPasses) {
    if (replaceOldestTurnsWithSummary(working, summarySegment, compactionActions, countTokens)) {
      passes += 1;
      continue;
    }
    if (dropLowestRankedToolBody(working, compactionActions, countTokens)) {
      passes += 1;
      continue;
    }
    if (shrinkOneExcerpt(working, excerptMinTokens, compactionActions, countTokens)) {
      passes += 1;
      continue;
    }
    break;
  }

  if (isOverBudget()) {
    throw ApiError.fromCode('CONTEXT_BUDGET_EXCEEDED', {
      details: {
        retryability: 'user_action_required',
        compactionActions,
        measuredInputTokens: measureCompetingInput(working, countTokens),
      },
    });
  }
  return compactionActions;
}

/**
 * Maps remaining segments to `ai` SDK-style message parts.
 * @param {object} segment Working segment.
 * @returns {{ role: string, content: string }}
 */
function mapSegmentToMessage(segment) {
  if (isSchemaSegment(segment)) {
    return { role: 'system', content: segment.content ?? '' };
  }
  if (segment.kind === TURN_KIND && segment.role) {
    return { role: segment.role, content: segment.content ?? '' };
  }
  return { role: 'user', content: segment.content ?? '' };
}

/**
 * Measures assembled segments, compacts when over budget, and returns a sendable
 * payload. Throws catalog errors — never returns fabricated token counts.
 * @param {{
 *   modelArtifactRef: string,
 *   purpose?: string,
 *   segments?: object[],
 *   summarySegment?: object,
 *   toolSchemaTokenOverhead?: number,
 *   options?: {
 *     tokenizer?: ReturnType<typeof createTokenizerAdapter>,
 *     llm?: { contextCapacity: number, artifactId: string },
 *     validatedContextCapacity?: number | null,
 *     reservedOutputTokens?: number | null,
 *     excerptMinTokens?: number,
 *     compactionMaxPasses?: number,
 *   },
 * }} input Assembly request.
 * @returns {{
 *   messages: { role: string, content: string }[],
 *   measuredInputTokens: number,
 *   maximumInputBudget: number,
 *   reservedOutputTokens: number,
 *   validatedContextCapacity: number,
 *   compactionActions: object[],
 * }}
 */
export function prepareModelInput(input) {
  const options = input?.options ?? {};
  const defaults = options.llm ? getContextBudgetConfig(options.llm) : null;
  const validatedContextCapacity =
    options.validatedContextCapacity === undefined ? defaults?.validatedContextCapacity : options.validatedContextCapacity;
  const reservedOutputTokens =
    options.reservedOutputTokens === undefined ? (defaults?.reservedOutputTokens ?? RESERVED_OUTPUT_TOKENS) : options.reservedOutputTokens;
  const excerptMinTokens = options.excerptMinTokens ?? defaults?.excerptMinTokens ?? EXCERPT_MIN_TOKENS;
  const compactionMaxPasses = options.compactionMaxPasses ?? defaults?.compactionMaxPasses ?? COMPACTION_MAX_PASSES;

  if (
    !Number.isFinite(validatedContextCapacity) ||
    validatedContextCapacity <= 0 ||
    !Number.isFinite(reservedOutputTokens) ||
    reservedOutputTokens < 0
  ) {
    throwAccountingUnavailable('evaluation_config_missing');
  }

  const tokenizer =
    options.tokenizer ??
    createTokenizerAdapter({
      expectedArtifactId: defaults?.artifactId,
    });
  try {
    tokenizer.assertArtifactMatch(input.modelArtifactRef);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CONTEXT_ACCOUNTING_UNAVAILABLE') {
      throw error;
    }
    throwAccountingUnavailable('tokenizer_artifact_mismatch');
  }

  const working = cloneSegments(input.segments);
  let systemAndToolSchemaTokens;
  let competingInput;
  try {
    systemAndToolSchemaTokens = measureSystemAndToolSchema(working, tokenizer.countTokens, input.toolSchemaTokenOverhead ?? 0);
    competingInput = measureCompetingInput(working, tokenizer.countTokens);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CONTEXT_ACCOUNTING_UNAVAILABLE') {
      throw error;
    }
    throwAccountingUnavailable('tokenizer_unavailable');
  }

  const maximumInputBudget = validatedContextCapacity - reservedOutputTokens - systemAndToolSchemaTokens;
  let compactionActions = [];
  if (competingInput > maximumInputBudget) {
    compactionActions = compactSegments({
      working,
      summarySegment: input.summarySegment,
      countTokens: tokenizer.countTokens,
      inputBudget: maximumInputBudget,
      excerptMinTokens,
      compactionMaxPasses,
    });
  }

  const measuredInputTokens = measureCompetingInput(working, tokenizer.countTokens);
  return {
    messages: working.map(mapSegmentToMessage),
    measuredInputTokens,
    maximumInputBudget,
    reservedOutputTokens,
    validatedContextCapacity,
    compactionActions,
  };
}
