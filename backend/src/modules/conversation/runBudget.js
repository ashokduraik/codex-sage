/**
 * Chat run-budget enforcer: cumulative tokens, tool-result bytes, total
 * model+tool calls, and wall time. Limits come from loadConfig().llm.runBudget
 * (set via backend/.env after `npm run measure-llm-host`).
 */
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../../platform/config.js';
import { ApiError, caughtErrorFields } from '../../platform/errors.js';

/**
 * Returns run-budget limits from process config (validated at startup).
 * @returns {{
 *   maxCumulativeInputTokens: number,
 *   maxCumulativeOutputTokens: number,
 *   maxCumulativeToolResultBytes: number,
 *   maxTotalCalls: number,
 *   maxWallTimeMs: number,
 * }}
 */
export function getRunBudgetConfig() {
  return { ...loadConfig().llm.runBudget };
}

/**
 * Throws when any configured run-budget dimension is at or over its limit.
 * @param {{
 *   cumulativeInputTokens?: number,
 *   cumulativeOutputTokens?: number,
 *   cumulativeToolResultBytes?: number,
 *   totalCalls?: number,
 *   runMonotonicStartedAt?: number | null,
 * }} state Graph counters.
 * @param {{
 *   maxCumulativeInputTokens?: number | null,
 *   maxCumulativeOutputTokens?: number | null,
 *   maxCumulativeToolResultBytes?: number | null,
 *   maxTotalCalls?: number | null,
 *   maxWallTimeMs?: number | null,
 * }} [config] Limits; defaults to getRunBudgetConfig().
 * @returns {void}
 * @throws {ApiError} RUN_BUDGET_EXCEEDED when a set limit is exceeded.
 */
export function assertRunBudget(state, config = getRunBudgetConfig()) {
  const checks = [
    {
      dimension: 'cumulativeInputTokens',
      limit: config.maxCumulativeInputTokens,
      value: state.cumulativeInputTokens ?? 0,
    },
    {
      dimension: 'cumulativeOutputTokens',
      limit: config.maxCumulativeOutputTokens,
      value: state.cumulativeOutputTokens ?? 0,
    },
    {
      dimension: 'cumulativeToolResultBytes',
      limit: config.maxCumulativeToolResultBytes,
      value: state.cumulativeToolResultBytes ?? 0,
    },
    {
      dimension: 'totalCalls',
      limit: config.maxTotalCalls,
      value: state.totalCalls ?? 0,
    },
  ];
  for (const check of checks) {
    if (!isEnforcedLimit(check.limit)) {
      continue;
    }
    if (check.value >= check.limit) {
      throwRunBudgetExceeded(check.dimension, check.value, check.limit);
    }
  }
  if (isEnforcedLimit(config.maxWallTimeMs)) {
    const startedAt = state.runMonotonicStartedAt;
    if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= config.maxWallTimeMs) {
        throwRunBudgetExceeded('wallTimeMs', elapsedMs, config.maxWallTimeMs);
      }
    }
  }
}

/**
 * Adds finite provider usage into cumulative token counters.
 * @param {{ cumulativeInputTokens?: number, cumulativeOutputTokens?: number }} state Prior counters.
 * @param {{ inputTokens?: number | null, outputTokens?: number | null } | null | undefined} usage Provider usage.
 * @returns {{ cumulativeInputTokens: number, cumulativeOutputTokens: number }}
 */
export function applyLlmUsageToRunBudget(state, usage) {
  const inputAdd = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0;
  const outputAdd = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : 0;
  return {
    cumulativeInputTokens: (state.cumulativeInputTokens ?? 0) + inputAdd,
    cumulativeOutputTokens: (state.cumulativeOutputTokens ?? 0) + outputAdd,
  };
}

/**
 * Adds tool result bytes and increments the total call counter after executeTool.
 * @param {{
 *   cumulativeToolResultBytes?: number,
 *   totalCalls?: number,
 * }} state Prior counters.
 * @param {{ resultBytes?: number } | null | undefined} toolUsage executeTool usage.
 * @returns {{ cumulativeToolResultBytes: number, totalCalls: number }}
 */
export function applyToolUsageToRunBudget(state, toolUsage) {
  const bytesAdd = Number.isFinite(toolUsage?.resultBytes) ? toolUsage.resultBytes : 0;
  return {
    cumulativeToolResultBytes: (state.cumulativeToolResultBytes ?? 0) + bytesAdd,
    totalCalls: (state.totalCalls ?? 0) + 1,
  };
}

/**
 * Increments totalCalls after a tool-choice (or other counted) model call.
 * @param {{ totalCalls?: number }} state Prior counters.
 * @returns {{ totalCalls: number }}
 */
export function applyModelCallToRunBudget(state) {
  return { totalCalls: (state.totalCalls ?? 0) + 1 };
}

/**
 * Ensures a monotonic start timestamp exists for wall-time checks.
 * @param {number | null | undefined} existing Prior value.
 * @returns {number}
 */
export function ensureRunMonotonicStartedAt(existing) {
  if (typeof existing === 'number' && Number.isFinite(existing)) {
    return existing;
  }
  return performance.now();
}

/**
 * @param {number | null | undefined} limit Configured limit.
 * @returns {boolean}
 */
function isEnforcedLimit(limit) {
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 0;
}

/**
 * Logs and throws RUN_BUDGET_EXCEEDED for one dimension.
 * @param {string} dimension Which limit tripped.
 * @param {number} value Observed value.
 * @param {number} limit Configured max.
 * @returns {never}
 */
function throwRunBudgetExceeded(dimension, value, limit) {
  const error = ApiError.fromCode('RUN_BUDGET_EXCEEDED', {
    details: { dimension, value, limit },
  });
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'chat run budget exceeded',
      dimension,
      value,
      limit,
      ...caughtErrorFields(error),
    }),
  );
  throw error;
}
