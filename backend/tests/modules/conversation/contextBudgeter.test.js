/**
 * Context budgeter: measurement, compaction order, and fail-closed accounting.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/platform/errors.js';
import {
  COMPACTION_MAX_PASSES,
  EXCERPT_MIN_TOKENS,
  RESERVED_OUTPUT_TOKENS,
  createTokenizerAdapter,
  getContextBudgetConfig,
  prepareModelInput,
} from '../../../src/modules/conversation/index.js';

/** Injected artifact id for tests; production uses the configured model id. */
const TEST_ARTIFACT_ID = 'test-artifact-id';

/**
 * Word-count tokenizer so tests can size budgets without a production package.
 * @param {string} text Segment text.
 * @returns {number}
 */
function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * @param {object} [overrides] Extra prepareModelInput fields.
 * @returns {object}
 */
function baseInput(overrides = {}) {
  return {
    modelArtifactRef: TEST_ARTIFACT_ID,
    purpose: 'draft',
    segments: [],
    options: {
      tokenizer: createTokenizerAdapter({
        countTokens: countWords,
        expectedArtifactId: TEST_ARTIFACT_ID,
      }),
      validatedContextCapacity: 40,
      reservedOutputTokens: 4,
      excerptMinTokens: 2,
      compactionMaxPasses: COMPACTION_MAX_PASSES,
    },
    ...overrides,
  };
}

describe('getContextBudgetConfig', () => {
  it('returns compaction constants plus injected capacity and artifact id', () => {
    expect(
      getContextBudgetConfig({
        contextCapacity: 131072,
        artifactId: TEST_ARTIFACT_ID,
      }),
    ).toEqual({
      validatedContextCapacity: 131072,
      reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
      excerptMinTokens: EXCERPT_MIN_TOKENS,
      compactionMaxPasses: COMPACTION_MAX_PASSES,
      artifactId: TEST_ARTIFACT_ID,
    });
    expect(RESERVED_OUTPUT_TOKENS).toBe(457);
    expect(EXCERPT_MIN_TOKENS).toBe(27);
  });

  it('throws when llm capacity or artifact id is missing', () => {
    expect(() => getContextBudgetConfig()).toThrow(ApiError);
    expect(() => getContextBudgetConfig({ contextCapacity: 131072 })).toThrow(ApiError);
    expect(() => getContextBudgetConfig({ artifactId: TEST_ARTIFACT_ID })).toThrow(ApiError);
    try {
      getContextBudgetConfig({ contextCapacity: 0, artifactId: TEST_ARTIFACT_ID });
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('evaluation_config_missing');
    }
  });
});

describe('createTokenizerAdapter', () => {
  it('fails closed when no production countTokens is wired', () => {
    const adapter = createTokenizerAdapter();
    expect(() => adapter.countTokens('hello')).toThrow(ApiError);
    try {
      adapter.countTokens('hello');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_unavailable');
    }
  });

  it('countMessage uses injected countTokens', () => {
    const adapter = createTokenizerAdapter({
      countTokens: countWords,
      expectedArtifactId: TEST_ARTIFACT_ID,
    });
    expect(adapter.countMessage({ content: 'one two three' })).toBe(3);
    expect(adapter.countMessage({})).toBe(0);
  });

  it('rejects an id that is not the expected artifact', () => {
    const adapter = createTokenizerAdapter({
      countTokens: countWords,
      expectedArtifactId: TEST_ARTIFACT_ID,
    });
    expect(() => adapter.assertArtifactMatch('other')).toThrow(ApiError);
    try {
      adapter.assertArtifactMatch('');
    } catch (error) {
      expect(error.details.reason).toBe('tokenizer_artifact_mismatch');
    }
  });

  it('fails closed when no expected artifact id is injected', () => {
    const adapter = createTokenizerAdapter({ countTokens: countWords });
    expect(() => adapter.assertArtifactMatch(TEST_ARTIFACT_ID)).toThrow(ApiError);
  });

  it('accepts the injected artifact id and a custom assertArtifactMatch seam', () => {
    const adapter = createTokenizerAdapter({
      countTokens: countWords,
      expectedArtifactId: TEST_ARTIFACT_ID,
    });
    expect(() => adapter.assertArtifactMatch(TEST_ARTIFACT_ID)).not.toThrow();
    let seen = '';
    const custom = createTokenizerAdapter({
      countTokens: countWords,
      assertArtifactMatch: (id) => {
        seen = id;
      },
    });
    custom.assertArtifactMatch('injected');
    expect(seen).toBe('injected');
  });
});

describe('prepareModelInput', () => {
  it('returns measured counts and no compaction when input is under budget', () => {
    const result = prepareModelInput(
      baseInput({
        segments: [
          { id: 'sys1', kind: 'system', content: 'Ground every answer.', protected: true },
          { id: 'q1', kind: 'user_question', content: 'How does refresh work?', protected: true },
        ],
        toolSchemaTokenOverhead: 1,
      }),
    );
    expect(result.compactionActions).toEqual([]);
    expect(result.measuredInputTokens).toBe(4);
    expect(result.validatedContextCapacity).toBe(40);
    expect(result.reservedOutputTokens).toBe(4);
    expect(result.maximumInputBudget).toBe(40 - 4 - 4);
    expect(result.messages).toEqual([
      { role: 'system', content: 'Ground every answer.' },
      { role: 'user', content: 'How does refresh work?' },
    ]);
  });

  it('replaces the oldest unprotected turn pair with the supplied summary first', () => {
    const result = prepareModelInput(
      baseInput({
        summarySegment: { id: 'sum', kind: 'summary', content: 'Older turns summarized.' },
        segments: [
          { id: 'sys1', kind: 'system', content: 'Rules here.', protected: true },
          { id: 'q1', kind: 'user_question', content: 'Current question now?', protected: true },
          { id: 't1', kind: 'turn', role: 'user', content: 'First old user turn text' },
          { id: 't2', kind: 'turn', role: 'assistant', content: 'First old assistant turn' },
          { id: 't3', kind: 'turn', role: 'user', content: 'Second old user turn text extra' },
        ],
        options: {
          tokenizer: createTokenizerAdapter({
            countTokens: countWords,
            expectedArtifactId: TEST_ARTIFACT_ID,
          }),
          validatedContextCapacity: 20,
          reservedOutputTokens: 2,
          excerptMinTokens: 2,
        },
      }),
    );
    expect(result.messages.some((message) => message.content === 'Rules here.')).toBe(true);
    expect(result.messages.some((message) => message.content === 'Current question now?')).toBe(true);
    expect(result.messages.some((message) => message.content.includes('First old user'))).toBe(false);
    expect(result.compactionActions[0]).toMatchObject({
      action: 'replace_with_summary',
      segmentId: 't1',
    });
    expect(result.compactionActions[0].beforeTokens).toBeGreaterThan(result.compactionActions[0].afterTokens);
  });

  it('drops later turns after the summary is already present', () => {
    const result = prepareModelInput(
      baseInput({
        summarySegment: { id: 'sum', content: 'Sum.' },
        segments: [
          { id: 'q1', kind: 'user_question', content: 'Q?', protected: true },
          { id: 't1', kind: 'turn', content: 'aaaaaaaa bbbbbbbb cccccccc' },
          { id: 't2', kind: 'turn', content: 'dddddddd eeeeeeee ffffffff' },
          { id: 't3', kind: 'turn', content: 'gggggggg hhhhhhhh iiiiiiii' },
        ],
        options: {
          tokenizer: createTokenizerAdapter({
            countTokens: countWords,
            expectedArtifactId: TEST_ARTIFACT_ID,
          }),
          validatedContextCapacity: 5,
          reservedOutputTokens: 1,
          excerptMinTokens: 1,
        },
      }),
    );
    const turnDrops = result.compactionActions.filter((action) => action.action === 'drop_turn');
    expect(result.compactionActions.some((action) => action.action === 'replace_with_summary')).toBe(true);
    expect(turnDrops.length).toBeGreaterThan(0);
  });

  it('drops the lowest-ranked tool body and keeps a source stub', () => {
    const result = prepareModelInput(
      baseInput({
        segments: [
          { id: 'q1', kind: 'user_question', content: 'Q?', protected: true },
          {
            id: 'tool-low',
            kind: 'tool_result',
            rank: 1,
            path: 'src/a.js',
            sourceId: 'ev-1',
            content: 'alpha beta gamma delta epsilon zeta eta theta',
          },
          {
            id: 'tool-high',
            kind: 'tool_result',
            rank: 9,
            path: 'src/b.js',
            sourceId: 'ev-2',
            content: 'one two',
          },
        ],
        options: {
          tokenizer: createTokenizerAdapter({
            countTokens: countWords,
            expectedArtifactId: TEST_ARTIFACT_ID,
          }),
          validatedContextCapacity: 10,
          reservedOutputTokens: 1,
          excerptMinTokens: 2,
        },
      }),
    );
    const drop = result.compactionActions.find((action) => action.action === 'drop_tool_body');
    expect(drop.segmentId).toBe('tool-low');
    const stub = result.messages.find((message) => message.content.includes('src/a.js'));
    expect(stub.content).toContain('ev-1');
    expect(result.messages.some((message) => message.content.includes('one two'))).toBe(true);
  });

  it('shrinks oversized excerpts monotonically until they fit or hit the floor', () => {
    const paragraph = 'First paragraph stays for a while longer than needed.\n\nSecond paragraph is discarded first.\n\nThird paragraph goes next.';
    const result = prepareModelInput(
      baseInput({
        segments: [
          { id: 'q1', kind: 'user_question', content: 'Q?', protected: true },
          { id: 'ex1', kind: 'excerpt', shrinkable: true, content: paragraph },
        ],
        options: {
          tokenizer: createTokenizerAdapter({
            countTokens: countWords,
            expectedArtifactId: TEST_ARTIFACT_ID,
          }),
          validatedContextCapacity: 14,
          reservedOutputTokens: 1,
          excerptMinTokens: 3,
        },
      }),
    );
    const shrinks = result.compactionActions.filter((action) => action.action === 'shrink_excerpt');
    expect(shrinks.length).toBeGreaterThan(0);
    for (const action of shrinks) {
      expect(action.afterTokens).toBeLessThan(action.beforeTokens);
    }
    expect(result.messages.some((message) => message.content.includes('Third paragraph'))).toBe(false);
  });

  it('shrinks a single-paragraph excerpt at sentence then word boundaries', () => {
    const result = prepareModelInput(
      baseInput({
        segments: [
          { id: 'q1', kind: 'user_question', content: 'Ask?', protected: true },
          {
            id: 'ex1',
            kind: 'excerpt',
            content: 'Alpha sentence one. Beta sentence two. Gamma sentence three extra words here.',
          },
        ],
        options: {
          tokenizer: createTokenizerAdapter({
            countTokens: countWords,
            expectedArtifactId: TEST_ARTIFACT_ID,
          }),
          validatedContextCapacity: 8,
          reservedOutputTokens: 1,
          excerptMinTokens: 2,
        },
      }),
    );
    expect(result.compactionActions.some((action) => action.action === 'shrink_excerpt')).toBe(true);
    expect(result.measuredInputTokens).toBeLessThanOrEqual(result.maximumInputBudget);
  });

  it('never removes protected segments while compacting', () => {
    const result = prepareModelInput(
      baseInput({
        summarySegment: { id: 'sum', content: 'Sum text.' },
        segments: [
          { id: 'sys1', kind: 'system', content: 'Protected system rules.', protected: true },
          { id: 'pin1', kind: 'pinned_fact', content: 'User said cookies.', protected: true },
          { id: 'c1', kind: 'clarification', content: 'Clarified org.', protected: true },
          { id: 'q1', kind: 'user_question', content: 'What now?', protected: true },
          { id: 't1', kind: 'turn', content: 'old turn one two three four five six' },
        ],
        options: {
          tokenizer: createTokenizerAdapter({
            countTokens: countWords,
            expectedArtifactId: TEST_ARTIFACT_ID,
          }),
          validatedContextCapacity: 18,
          reservedOutputTokens: 2,
          excerptMinTokens: 2,
        },
      }),
    );
    const contents = result.messages.map((message) => message.content);
    expect(contents).toEqual(expect.arrayContaining(['Protected system rules.', 'User said cookies.', 'Clarified org.', 'What now?']));
  });

  it('maps turn roles onto the outgoing messages array', () => {
    const result = prepareModelInput(
      baseInput({
        segments: [{ id: 't1', kind: 'turn', role: 'assistant', content: 'Prior answer.' }],
        options: {
          tokenizer: createTokenizerAdapter({
            countTokens: countWords,
            expectedArtifactId: TEST_ARTIFACT_ID,
          }),
          validatedContextCapacity: 20,
          reservedOutputTokens: 1,
        },
      }),
    );
    expect(result.messages[0]).toEqual({ role: 'assistant', content: 'Prior answer.' });
  });

  it('throws CONTEXT_ACCOUNTING_UNAVAILABLE when evaluation numbers are missing', () => {
    expect(() =>
      prepareModelInput(
        baseInput({
          segments: [{ id: 'q1', kind: 'user_question', content: 'Q?', protected: true }],
          options: {
            tokenizer: createTokenizerAdapter({
              countTokens: countWords,
              expectedArtifactId: TEST_ARTIFACT_ID,
            }),
            validatedContextCapacity: null,
            reservedOutputTokens: 4,
          },
        }),
      ),
    ).toThrow(ApiError);
    try {
      prepareModelInput(
        baseInput({
          options: {
            tokenizer: createTokenizerAdapter({
              countTokens: countWords,
              expectedArtifactId: TEST_ARTIFACT_ID,
            }),
            validatedContextCapacity: 0,
            reservedOutputTokens: 4,
          },
        }),
      );
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('evaluation_config_missing');
      expect(error).not.toHaveProperty('messages');
    }
  });

  it('fails closed when the default tokenizer has no production implementation', () => {
    try {
      prepareModelInput({
        modelArtifactRef: TEST_ARTIFACT_ID,
        segments: [{ id: 'q1', kind: 'user_question', content: 'Hello world', protected: true }],
        options: {
          llm: { contextCapacity: 40, artifactId: TEST_ARTIFACT_ID },
        },
      });
      expect.fail('expected throw');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_unavailable');
    }
  });

  it('fails closed on artifact mismatch and wraps unexpected assert errors', () => {
    try {
      prepareModelInput(
        baseInput({
          modelArtifactRef: 'wrong-digest',
          segments: [{ id: 'q1', kind: 'user_question', content: 'Q?', protected: true }],
        }),
      );
      expect.fail('expected throw');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_artifact_mismatch');
    }

    try {
      prepareModelInput(
        baseInput({
          options: {
            tokenizer: createTokenizerAdapter({
              countTokens: countWords,
              assertArtifactMatch: () => {
                throw new Error('boom');
              },
            }),
            validatedContextCapacity: 20,
            reservedOutputTokens: 1,
          },
        }),
      );
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_artifact_mismatch');
    }
  });

  it('wraps unexpected tokenizer throws as CONTEXT_ACCOUNTING_UNAVAILABLE', () => {
    try {
      prepareModelInput(
        baseInput({
          segments: [{ id: 'q1', kind: 'user_question', content: 'Q?', protected: true }],
          options: {
            tokenizer: createTokenizerAdapter({
              countTokens: () => {
                throw new Error('parity failed');
              },
              expectedArtifactId: TEST_ARTIFACT_ID,
            }),
            validatedContextCapacity: 20,
            reservedOutputTokens: 1,
          },
        }),
      );
    } catch (error) {
      expect(error.code).toBe('CONTEXT_ACCOUNTING_UNAVAILABLE');
      expect(error.details.reason).toBe('tokenizer_unavailable');
    }
  });

  it('throws CONTEXT_BUDGET_EXCEEDED when only protected blocks still overflow', () => {
    try {
      prepareModelInput(
        baseInput({
          segments: [
            { id: 'sys1', kind: 'system', content: 'Long system grounding rules stay.', protected: true },
            {
              id: 'q1',
              kind: 'user_question',
              content: 'This current question is also quite long and protected.',
              protected: true,
            },
          ],
          options: {
            tokenizer: createTokenizerAdapter({
              countTokens: countWords,
              expectedArtifactId: TEST_ARTIFACT_ID,
            }),
            validatedContextCapacity: 12,
            reservedOutputTokens: 6,
            excerptMinTokens: 2,
          },
        }),
      );
      expect.fail('expected throw');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_BUDGET_EXCEEDED');
      expect(error.details.retryability).toBe('user_action_required');
      expect(Array.isArray(error.details.compactionActions)).toBe(true);
    }
  });

  it('throws CONTEXT_BUDGET_EXCEEDED when compaction passes are exhausted', () => {
    try {
      prepareModelInput(
        baseInput({
          segments: [
            { id: 'q1', kind: 'user_question', content: 'Q?', protected: true },
            { id: 't1', kind: 'turn', content: 'one two three four five six seven eight' },
            { id: 't2', kind: 'turn', content: 'nine ten eleven twelve thirteen fourteen' },
            { id: 't3', kind: 'turn', content: 'fifteen sixteen seventeen eighteen nineteen' },
          ],
          options: {
            tokenizer: createTokenizerAdapter({
              countTokens: countWords,
              expectedArtifactId: TEST_ARTIFACT_ID,
            }),
            validatedContextCapacity: 6,
            reservedOutputTokens: 1,
            excerptMinTokens: 2,
            compactionMaxPasses: 1,
          },
        }),
      );
      expect.fail('expected throw');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_BUDGET_EXCEEDED');
      expect(error.details.compactionActions.length).toBeGreaterThan(0);
    }
  });

  it('uses the injected llm capacity when options omit capacity overrides', () => {
    const result = prepareModelInput({
      modelArtifactRef: TEST_ARTIFACT_ID,
      segments: [{ id: 'q1', kind: 'user_question', content: 'Short ask', protected: true }],
      options: {
        tokenizer: createTokenizerAdapter({
          countTokens: countWords,
          expectedArtifactId: TEST_ARTIFACT_ID,
        }),
        llm: { contextCapacity: 131072, artifactId: TEST_ARTIFACT_ID },
      },
    });
    expect(result.validatedContextCapacity).toBe(131072);
    expect(result.reservedOutputTokens).toBe(RESERVED_OUTPUT_TOKENS);
    expect(result.maximumInputBudget).toBe(131072 - RESERVED_OUTPUT_TOKENS);
  });

  it('treats negative reserved output as missing evaluation config', () => {
    try {
      prepareModelInput(
        baseInput({
          options: {
            tokenizer: createTokenizerAdapter({
              countTokens: countWords,
              expectedArtifactId: TEST_ARTIFACT_ID,
            }),
            validatedContextCapacity: 20,
            reservedOutputTokens: -1,
          },
        }),
      );
    } catch (error) {
      expect(error.details.reason).toBe('evaluation_config_missing');
    }
  });

  it('inserts a summary at the end when every remaining segment is schema', () => {
    const result = prepareModelInput(
      baseInput({
        summarySegment: { id: 'sum', content: 'Sum.' },
        segments: [
          { id: 'schema1', kind: 'tool_schema', content: 'tools' },
          { id: 't1', kind: 'turn', content: 'aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee ffffffff' },
        ],
        options: {
          tokenizer: createTokenizerAdapter({
            countTokens: countWords,
            expectedArtifactId: TEST_ARTIFACT_ID,
          }),
          validatedContextCapacity: 8,
          reservedOutputTokens: 2,
          excerptMinTokens: 1,
        },
      }),
    );
    expect(result.messages.some((message) => message.content === 'Sum.')).toBe(true);
  });

  it('shrinks a word-only excerpt with binary search toward the floor', () => {
    const result = prepareModelInput(
      baseInput({
        segments: [
          { id: 'q1', kind: 'user_question', content: 'Q?', protected: true },
          {
            id: 'ex1',
            kind: 'excerpt',
            content: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet',
          },
        ],
        options: {
          tokenizer: createTokenizerAdapter({
            countTokens: countWords,
            expectedArtifactId: TEST_ARTIFACT_ID,
          }),
          validatedContextCapacity: 8,
          reservedOutputTokens: 1,
          excerptMinTokens: 3,
        },
      }),
    );
    expect(result.compactionActions.some((action) => action.action === 'shrink_excerpt')).toBe(true);
    expect(result.measuredInputTokens).toBeLessThanOrEqual(result.maximumInputBudget);
  });

  it('does not treat a one-word excerpt as shrinkable progress', () => {
    try {
      prepareModelInput(
        baseInput({
          segments: [
            { id: 'q1', kind: 'user_question', content: 'Protected question words stay here forever.', protected: true },
            { id: 'ex1', kind: 'excerpt', content: 'Word' },
          ],
          options: {
            tokenizer: createTokenizerAdapter({
              countTokens: countWords,
              expectedArtifactId: TEST_ARTIFACT_ID,
            }),
            validatedContextCapacity: 8,
            reservedOutputTokens: 4,
            excerptMinTokens: 1,
          },
        }),
      );
      expect.fail('expected throw');
    } catch (error) {
      expect(error.code).toBe('CONTEXT_BUDGET_EXCEEDED');
    }
  });
});
