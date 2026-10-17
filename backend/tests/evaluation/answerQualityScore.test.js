/**
 * Pure answer-quality scorer tests (no live LLM).
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateAnswerQualityScores,
  evidenceHitsGold,
  isAbstainOutcome,
  lineRangesOverlap,
  normalizeCitationPath,
  scoreAnswerQualityCase,
  scoreCitationCase,
} from '../../../docs/evaluation/answerQualityScore.js';

describe('normalizeCitationPath', () => {
  it('normalizes slashes and leading dots', () => {
    expect(normalizeCitationPath('.\\backend\\src\\a.js')).toBe('backend/src/a.js');
    expect(normalizeCitationPath('/backend/src/a.js')).toBe('backend/src/a.js');
  });
});

describe('lineRangesOverlap', () => {
  it('detects inclusive overlap', () => {
    expect(lineRangesOverlap({ start: 10, end: 20 }, { start: 15, end: 25 })).toBe(true);
    expect(lineRangesOverlap({ start: 10, end: 12 }, { start: 13, end: 14 })).toBe(false);
  });
});

describe('evidenceHitsGold', () => {
  it('requires path equality and overlapping lines', () => {
    const gold = { path: 'backend/src/a.js', startLine: 10, endLine: 20 };
    expect(evidenceHitsGold({ path: 'backend/src/a.js', startLine: 18, endLine: 22 }, gold)).toBe(true);
    expect(evidenceHitsGold({ path: 'backend/src/b.js', startLine: 10, endLine: 20 }, gold)).toBe(false);
    expect(evidenceHitsGold({ path: 'backend/src/a.js', startLine: 21, endLine: 22 }, gold)).toBe(false);
  });
});

describe('scoreCitationCase', () => {
  it('computes recall and precision', () => {
    const gold = {
      citations: [
        { path: 'a.js', startLine: 1, endLine: 5 },
        { path: 'b.js', startLine: 10, endLine: 12 },
      ],
    };
    const evidence = [
      { path: 'a.js', startLine: 2, endLine: 3 },
      { path: 'c.js', startLine: 1, endLine: 2 },
    ];
    const scored = scoreCitationCase(gold, evidence);
    expect(scored.hits).toBe(1);
    expect(scored.recall).toBe(0.5);
    expect(scored.precision).toBe(0.5);
    expect(scored.citationPass).toBe(false);
  });

  it('passes when every gold citation is hit', () => {
    const gold = { citations: [{ path: 'a.js', startLine: 1, endLine: 2 }] };
    const evidence = [
      { path: 'a.js', startLine: 1, endLine: 2 },
      { path: 'extra.js', startLine: 1, endLine: 1 },
    ];
    const scored = scoreCitationCase(gold, evidence);
    expect(scored.citationPass).toBe(true);
    expect(scored.recall).toBe(1);
  });
});

describe('isAbstainOutcome', () => {
  it('recognizes abstain terminals', () => {
    expect(isAbstainOutcome({ messageStatus: 'abstained' })).toBe(true);
    expect(isAbstainOutcome({ supportLevel: 'insufficient' })).toBe(true);
    expect(isAbstainOutcome({ route: 'abstain_early' })).toBe(true);
    expect(isAbstainOutcome({ messageStatus: 'completed' })).toBe(false);
  });
});

describe('scoreAnswerQualityCase', () => {
  it('passes abstain when status is abstained and no evidence', () => {
    const scored = scoreAnswerQualityCase({ expect: 'abstain', citations: [] }, { messageStatus: 'abstained', evidence: [] });
    expect(scored.pass).toBe(true);
    expect(scored.falseAnswer).toBe(false);
  });

  it('fails abstain when the model answers', () => {
    const scored = scoreAnswerQualityCase(
      { expect: 'abstain', citations: [] },
      { messageStatus: 'completed', evidence: [{ path: 'a.js', startLine: 1 }] },
    );
    expect(scored.pass).toBe(false);
    expect(scored.falseAnswer).toBe(true);
  });

  it('flags false abstain on answer cases', () => {
    const scored = scoreAnswerQualityCase(
      { expect: 'answer', citations: [{ path: 'a.js', startLine: 1, endLine: 2 }] },
      { messageStatus: 'abstained', evidence: [] },
    );
    expect(scored.pass).toBe(false);
    expect(scored.falseAbstain).toBe(true);
  });
});

describe('aggregateAnswerQualityScores', () => {
  it('computes suite rates and floor', () => {
    const suite = aggregateAnswerQualityScores(
      [
        { expect: 'answer', pass: true, citationPass: true, precision: 1, recall: 1, falseAbstain: false, falseAnswer: false },
        { expect: 'answer', pass: false, citationPass: false, precision: 0, recall: 0, falseAbstain: true, falseAnswer: false },
        { expect: 'abstain', pass: true, citationPass: true, precision: 1, recall: 1, falseAbstain: false, falseAnswer: false },
        { expect: 'abstain', pass: true, citationPass: true, precision: 1, recall: 1, falseAbstain: false, falseAnswer: false },
      ],
      0.8,
    );
    expect(suite.citationPassRate).toBe(0.5);
    expect(suite.abstainPassRate).toBe(1);
    expect(suite.falseAbstainRate).toBe(0.5);
    expect(suite.suitePass).toBe(false);
  });
});
