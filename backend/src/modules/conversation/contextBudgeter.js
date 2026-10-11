/**
 * Conversation context budgeter — measure assembled prompt segments with
 * countTokensForBudget, compact in solution §1.2 order, and fail closed when
 * counting is unavailable. No HTTP; callers are LLM / tool / loader code.
 */
import { countTokensForBudget } from './tokenCount.js';
import { ApiError, apiErrorFromCaught } from '../../platform/errors.js';

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
 * Compaction constants plus caller-supplied capacity and live artifact id.
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
 * Measures assembled segments, compacts when over budget, and returns a sendable
 * payload. Throws catalog errors — never returns fabricated token counts.
 * @param {{
 *   modelArtifactRef: string,
 *   purpose?: string,
 *   segments?: object[],
 *   summarySegment?: object,
 *   toolSchemaTokenOverhead?: number,
 *   options?: {
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

  const expectedArtifactId = defaults?.artifactId ?? '';
  if (!expectedArtifactId || !input.modelArtifactRef || String(input.modelArtifactRef) !== String(expectedArtifactId)) {
    throwAccountingUnavailable('tokenizer_artifact_mismatch');
  }

  const working = (input.segments ?? []).map((segment) => ({ ...segment, content: segment.content ?? '' }));
  let systemAndToolSchemaTokens;
  let competingInput;
  try {
    systemAndToolSchemaTokens = measureSystemAndToolSchema(working, countTokensForBudget, input.toolSchemaTokenOverhead ?? 0);
    competingInput = measureCompetingInput(working, countTokensForBudget);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'CONTEXT_ACCOUNTING_UNAVAILABLE') {
      throw error;
    }
    throwAccountingUnavailable('tokenizer_unavailable', error);
  }

  const maximumInputBudget = validatedContextCapacity - reservedOutputTokens - systemAndToolSchemaTokens;
  let compactionActions = [];
  if (competingInput > maximumInputBudget) {
    compactionActions = compactSegments({
      working,
      summarySegment: input.summarySegment,
      countTokens: countTokensForBudget,
      inputBudget: maximumInputBudget,
      excerptMinTokens,
      compactionMaxPasses,
    });
  }

  const measuredInputTokens = measureCompetingInput(working, countTokensForBudget);
  return {
    messages: working.map(mapSegmentToMessage),
    measuredInputTokens,
    maximumInputBudget,
    reservedOutputTokens,
    validatedContextCapacity,
    compactionActions,
  };

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
   * Compacts in solution §1.2 order until the competing input fits or we must fail.
   * @param {object} args Compaction args.
   * @returns {object[]}
   */
  function compactSegments(args) {
    const { working, summarySegment, countTokens, inputBudget, excerptMinTokens, compactionMaxPasses } = args;
    const compactionActions = [];
    let passes = 0;

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

    /**
     * @returns {boolean}
     */
    function isOverBudget() {
      return measureCompetingInput(working, countTokens) > inputBudget;
    }

    /**
     * Collapses the oldest unprotected turn (and its following turn mate when present)
     * into the caller-supplied summary. Returns whether an action ran.
     * @param {object[]} workingSet Mutated working set.
     * @param {object | undefined} summary Caller summary.
     * @param {object[]} actions Audit log.
     * @param {(text: string) => number} count Adapter.
     * @returns {boolean}
     */
    function replaceOldestTurnsWithSummary(workingSet, summary, actions, count) {
      const firstTurnIndex = workingSet.findIndex(isUnprotectedTurn);
      if (firstTurnIndex < 0) {
        return false;
      }
      const removed = [workingSet[firstTurnIndex]];
      workingSet.splice(firstTurnIndex, 1);
      if (workingSet[firstTurnIndex] && isUnprotectedTurn(workingSet[firstTurnIndex])) {
        removed.push(workingSet[firstTurnIndex]);
        workingSet.splice(firstTurnIndex, 1);
      }
      const beforeTokens = removed.reduce((sum, segment) => sum + count(segment.content ?? ''), 0);
      const summaryAlreadyPresent = workingSet.some((segment) => segment.kind === SUMMARY_KIND);
      let afterTokens = 0;
      if (summary && !summaryAlreadyPresent) {
        const summaryCopy = { ...summary, kind: SUMMARY_KIND, content: summary.content ?? '' };
        const insertAt = workingSet.findIndex((segment) => !isSchemaSegment(segment));
        workingSet.splice(insertAt < 0 ? workingSet.length : insertAt, 0, summaryCopy);
        afterTokens = count(summaryCopy.content);
      }
      actions.push({
        action: summary && !summaryAlreadyPresent ? 'replace_with_summary' : 'drop_turn',
        segmentId: removed[0].id,
        beforeTokens,
        afterTokens,
      });
      return true;
    }

    /**
     * Drops the lowest-ranked unprotected tool body and keeps a source stub.
     * @param {object[]} workingSet Mutated working set.
     * @param {object[]} actions Audit log.
     * @param {(text: string) => number} count Adapter.
     * @returns {boolean}
     */
    function dropLowestRankedToolBody(workingSet, actions, count) {
      const candidates = workingSet.filter(
        (segment) => segment.kind === TOOL_RESULT_KIND && !isProtectedSegment(segment) && segment.stubbed !== true,
      );
      if (candidates.length === 0) {
        return false;
      }
      candidates.sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0));
      const target = candidates[0];
      const beforeTokens = count(target.content ?? '');
      const path = target.path ?? '';
      const sourceId = target.sourceId ?? '';
      target.content = `[source: ${path} ${sourceId}]`.trim();
      target.stubbed = true;
      const afterTokens = count(target.content);
      actions.push({
        action: 'drop_tool_body',
        segmentId: target.id,
        beforeTokens,
        afterTokens,
      });
      return true;
    }

    /**
     * Shrinks one excerpt at a paragraph, then sentence, then word boundary.
     * @param {object[]} workingSet Mutated working set.
     * @param {number} minTokens Floor.
     * @param {object[]} actions Audit log.
     * @param {(text: string) => number} count Adapter.
     * @returns {boolean}
     */
    function shrinkOneExcerpt(workingSet, minTokens, actions, count) {
      const target = workingSet.find((segment) => isShrinkableExcerpt(segment) && count(segment.content ?? '') > minTokens);
      if (!target) {
        return false;
      }
      const beforeTokens = count(target.content ?? '');
      const nextContent = shrinkExcerptContent(target.content, minTokens, count);
      if (nextContent === target.content) {
        return false;
      }
      target.content = nextContent;
      const afterTokens = count(target.content);
      if (afterTokens >= beforeTokens) {
        return false;
      }
      actions.push({
        action: 'shrink_excerpt',
        segmentId: target.id,
        beforeTokens,
        afterTokens,
      });
      return true;

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
    function isUnprotectedTurn(segment) {
      return segment.kind === TURN_KIND && !isProtectedSegment(segment);
    }
  }
}

/**
 * @param {object} segment Prompt block.
 * @returns {boolean}
 */
function isSchemaSegment(segment) {
  return SCHEMA_KINDS.has(segment.kind);
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
 * Throws the fail-closed accounting error (never returns guessed sizes).
 * @param {string} reason Machine-readable reason for logs / callers.
 * @param {unknown} [cause] Original failure when mapping from a catch.
 * @returns {never}
 */
function throwAccountingUnavailable(reason, cause) {
  if (cause !== undefined) {
    throw apiErrorFromCaught('CONTEXT_ACCOUNTING_UNAVAILABLE', cause, {
      details: { reason },
      logMessage: 'context accounting unavailable',
      fields: { reason },
    });
  }
  throw ApiError.fromCode('CONTEXT_ACCOUNTING_UNAVAILABLE', {
    details: { reason },
  });
}
