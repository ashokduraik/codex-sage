/**
 * Unit tests for chat run-budget enforcer and counter helpers.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../../../src/platform/errors.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/platform/config.js', () => ({
  loadConfig: () => ({
    llm: {
      runBudget: {
        maxCumulativeInputTokens: 500_000,
        maxCumulativeOutputTokens: 50_000,
        maxCumulativeToolResultBytes: 200_000,
        maxTotalCalls: 40,
        maxWallTimeMs: 120_000,
      },
    },
  }),
}));

import {
  assertRunBudget,
  getRunBudgetConfig,
  applyLlmUsageToRunBudget,
  applyModelCallToRunBudget,
  applyToolUsageToRunBudget,
  ensureRunMonotonicStartedAt,
} from '../../../src/modules/conversation/runBudget.js';

/**
 * @param {() => void} fn Function expected to throw ApiError.
 * @returns {ApiError}
 */
function expectApiError(fn) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error;
  }
  throw new Error('expected ApiError');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('getRunBudgetConfig', () => {
  it('returns positive limits from process config', () => {
    const config = getRunBudgetConfig();
    expect(config.maxCumulativeInputTokens).toBeGreaterThan(0);
    expect(config.maxCumulativeOutputTokens).toBeGreaterThan(0);
    expect(config.maxCumulativeToolResultBytes).toBeGreaterThan(0);
    expect(config.maxTotalCalls).toBeGreaterThan(0);
    expect(config.maxWallTimeMs).toBeGreaterThan(0);
  });
});

describe('assertRunBudget', () => {
  it('skips null dimensions and does not throw', () => {
    expect(() =>
      assertRunBudget(
        {
          cumulativeInputTokens: 1_000_000,
          cumulativeOutputTokens: 1_000_000,
          cumulativeToolResultBytes: 1_000_000,
          totalCalls: 1_000_000,
          runMonotonicStartedAt: 0,
        },
        {
          maxCumulativeInputTokens: null,
          maxCumulativeOutputTokens: null,
          maxCumulativeToolResultBytes: null,
          maxTotalCalls: null,
          maxWallTimeMs: null,
        },
      ),
    ).not.toThrow();
  });

  it('trips each configured dimension independently', () => {
    const base = {
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeToolResultBytes: 0,
      totalCalls: 0,
      runMonotonicStartedAt: performance.now(),
    };
    expect(
      expectApiError(() =>
        assertRunBudget(
          { ...base, cumulativeInputTokens: 10 },
          {
            maxCumulativeInputTokens: 10,
            maxCumulativeOutputTokens: null,
            maxCumulativeToolResultBytes: null,
            maxTotalCalls: null,
            maxWallTimeMs: null,
          },
        ),
      ),
    ).toMatchObject({ code: 'RUN_BUDGET_EXCEEDED', details: { dimension: 'cumulativeInputTokens' } });

    expect(
      expectApiError(() =>
        assertRunBudget(
          { ...base, cumulativeOutputTokens: 5 },
          {
            maxCumulativeInputTokens: null,
            maxCumulativeOutputTokens: 5,
            maxCumulativeToolResultBytes: null,
            maxTotalCalls: null,
            maxWallTimeMs: null,
          },
        ),
      ).message,
    ).toMatch(/processing limit/);

    expect(
      expectApiError(() =>
        assertRunBudget(
          { ...base, cumulativeToolResultBytes: 99 },
          {
            maxCumulativeInputTokens: null,
            maxCumulativeOutputTokens: null,
            maxCumulativeToolResultBytes: 99,
            maxTotalCalls: null,
            maxWallTimeMs: null,
          },
        ),
      ),
    ).toMatchObject({ code: 'RUN_BUDGET_EXCEEDED', details: { dimension: 'cumulativeToolResultBytes' } });

    expect(
      expectApiError(() =>
        assertRunBudget(
          { ...base, totalCalls: 3 },
          {
            maxCumulativeInputTokens: null,
            maxCumulativeOutputTokens: null,
            maxCumulativeToolResultBytes: null,
            maxTotalCalls: 3,
            maxWallTimeMs: null,
          },
        ),
      ),
    ).toMatchObject({ code: 'RUN_BUDGET_EXCEEDED', details: { dimension: 'totalCalls' } });
  });

  it('trips wall time when monotonic elapsed exceeds the limit', () => {
    const started = performance.now() - 50;
    expect(
      expectApiError(() =>
        assertRunBudget(
          {
            cumulativeInputTokens: 0,
            cumulativeOutputTokens: 0,
            cumulativeToolResultBytes: 0,
            totalCalls: 0,
            runMonotonicStartedAt: started,
          },
          {
            maxCumulativeInputTokens: null,
            maxCumulativeOutputTokens: null,
            maxCumulativeToolResultBytes: null,
            maxTotalCalls: null,
            maxWallTimeMs: 10,
          },
        ),
      ),
    ).toMatchObject({ code: 'RUN_BUDGET_EXCEEDED', details: expect.objectContaining({ dimension: 'wallTimeMs' }) });
  });

  it('does not throw when wall limit is set but start timestamp is missing', () => {
    expect(() =>
      assertRunBudget(
        {
          cumulativeInputTokens: 0,
          cumulativeOutputTokens: 0,
          cumulativeToolResultBytes: 0,
          totalCalls: 0,
          runMonotonicStartedAt: null,
        },
        {
          maxCumulativeInputTokens: null,
          maxCumulativeOutputTokens: null,
          maxCumulativeToolResultBytes: null,
          maxTotalCalls: null,
          maxWallTimeMs: 1,
        },
      ),
    ).not.toThrow();
  });

  it('does not throw when elapsed wall time is still under the limit', () => {
    expect(() =>
      assertRunBudget(
        {
          cumulativeInputTokens: 0,
          cumulativeOutputTokens: 0,
          cumulativeToolResultBytes: 0,
          totalCalls: 0,
          runMonotonicStartedAt: performance.now(),
        },
        {
          maxCumulativeInputTokens: null,
          maxCumulativeOutputTokens: null,
          maxCumulativeToolResultBytes: null,
          maxTotalCalls: null,
          maxWallTimeMs: 60_000,
        },
      ),
    ).not.toThrow();
  });
});

describe('usage helpers', () => {
  it('adds only finite LLM token usage', () => {
    expect(applyLlmUsageToRunBudget({ cumulativeInputTokens: 2, cumulativeOutputTokens: 1 }, { inputTokens: 3, outputTokens: null })).toEqual({
      cumulativeInputTokens: 5,
      cumulativeOutputTokens: 1,
    });
    expect(applyLlmUsageToRunBudget({}, null)).toEqual({
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
    });
  });

  it('adds tool bytes and increments totalCalls', () => {
    expect(applyToolUsageToRunBudget({ cumulativeToolResultBytes: 10, totalCalls: 1 }, { resultBytes: 5 })).toEqual({
      cumulativeToolResultBytes: 15,
      totalCalls: 2,
    });
    expect(applyToolUsageToRunBudget({}, null)).toEqual({
      cumulativeToolResultBytes: 0,
      totalCalls: 1,
    });
    expect(applyModelCallToRunBudget({})).toEqual({ totalCalls: 1 });
  });

  it('preserves an existing monotonic start timestamp', () => {
    expect(ensureRunMonotonicStartedAt(12.5)).toBe(12.5);
    expect(ensureRunMonotonicStartedAt(null)).toBeGreaterThan(0);
  });
});

describe('no fixed tool-round cap', () => {
  it('does not define MAX_TOOL_ROUNDS in the conversation module', () => {
    const conversationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/modules/conversation');
    const files = ['runBudget.js', 'chatGraph.js', 'chatGraph.helper.js', 'agentTools.js', 'index.js'];
    for (const name of files) {
      const source = readFileSync(path.join(conversationDir, name), 'utf8');
      expect(source).not.toMatch(/MAX_TOOL_ROUNDS/);
    }
  });
});
