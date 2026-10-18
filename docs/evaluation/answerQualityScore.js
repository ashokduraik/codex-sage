/**
 * Pure citation / abstain scoring for the answer-quality evaluation suite.
 * Application runtime does not import this; Vitest and the operator runner do.
 */

/**
 * Normalizes a repo-relative path for comparison.
 * @param {string} path Path string.
 * @returns {string}
 */
export function normalizeCitationPath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/**
 * Line span for a citation (missing end ⇒ single-line).
 * @param {{ startLine?: number, endLine?: number, start?: number, end?: number }} citation Citation-like object.
 * @returns {{ start: number, end: number } | null}
 */
export function citationLineSpan(citation) {
  const startRaw = citation?.startLine ?? citation?.start;
  const endRaw = citation?.endLine ?? citation?.end ?? startRaw;
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isFinite(start) || start < 1) {
    return null;
  }
  const safeEnd = Number.isFinite(end) && end >= start ? end : start;
  return { start, end: safeEnd };
}

/**
 * True when two line ranges overlap (inclusive).
 * @param {{ start: number, end: number }} a First span.
 * @param {{ start: number, end: number }} b Second span.
 * @returns {boolean}
 */
export function lineRangesOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * True when an evidence item hits a gold citation (path equal + line overlap).
 * @param {{ path?: string, startLine?: number, endLine?: number }} evidence Emitted evidence.
 * @param {{ path: string, startLine: number, endLine?: number }} gold Gold citation.
 * @returns {boolean}
 */
export function evidenceHitsGold(evidence, gold) {
  if (normalizeCitationPath(evidence?.path) !== normalizeCitationPath(gold?.path)) {
    return false;
  }
  const a = citationLineSpan(evidence);
  const b = citationLineSpan(gold);
  if (!a || !b) {
    return false;
  }
  return lineRangesOverlap(a, b);
}

/**
 * Scores one answer case for citation precision / recall / pass.
 * @param {{ citations: Array<{ path: string, startLine: number, endLine?: number }> }} goldCase Gold case.
 * @param {Array<{ path?: string, startLine?: number, endLine?: number }>} evidenceItems Emitted evidence.
 * @returns {{ precision: number, recall: number, citationPass: boolean, hits: number }}
 */
export function scoreCitationCase(goldCase, evidenceItems) {
  const gold = Array.isArray(goldCase?.citations) ? goldCase.citations : [];
  const emitted = Array.isArray(evidenceItems) ? evidenceItems : [];
  if (gold.length === 0) {
    return { precision: 1, recall: 1, citationPass: true, hits: 0 };
  }
  let hits = 0;
  for (const g of gold) {
    if (emitted.some((ev) => evidenceHitsGold(ev, g))) {
      hits += 1;
    }
  }
  const recall = hits / gold.length;
  const precision = emitted.length === 0 ? 0 : hits / emitted.length;
  return {
    precision,
    recall,
    citationPass: recall >= 1,
    hits,
  };
}

/**
 * True when the terminal outcome is an abstain.
 * @param {{ messageStatus?: string, supportLevel?: string, route?: string }} outcome Run outcome.
 * @returns {boolean}
 */
export function isAbstainOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return false;
  }
  if (outcome.messageStatus === 'abstained') {
    return true;
  }
  if (outcome.supportLevel === 'insufficient' || outcome.supportLevel === 'abstain') {
    return true;
  }
  if (outcome.route === 'abstain_early') {
    return true;
  }
  return false;
}

/**
 * True when the terminal outcome is a completed direct reply (no evidence).
 * @param {{ messageStatus?: string, supportLevel?: string, evidence?: object[] }} outcome Run outcome.
 * @returns {boolean}
 */
export function isDirectReplyOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return false;
  }
  if (outcome.messageStatus !== 'completed') {
    return false;
  }
  if (isAbstainOutcome(outcome)) {
    return false;
  }
  const evidence = Array.isArray(outcome.evidence) ? outcome.evidence : [];
  if (evidence.length > 0) {
    return false;
  }
  // Grounded answers set supportLevel; direct replies leave it null.
  return outcome.supportLevel == null;
}

/**
 * Scores one case (answer, abstain, or direct_reply).
 * @param {{ expect: 'answer' | 'abstain' | 'direct_reply', citations?: object[] }} goldCase Gold case.
 * @param {{
 *   messageStatus?: string,
 *   supportLevel?: string,
 *   route?: string,
 *   evidence?: object[],
 * }} outcome Observed outcome.
 * @returns {{
 *   pass: boolean,
 *   falseAbstain: boolean,
 *   falseAnswer: boolean,
 *   precision: number,
 *   recall: number,
 *   citationPass: boolean,
 * }}
 */
export function scoreAnswerQualityCase(goldCase, outcome) {
  const evidence = Array.isArray(outcome?.evidence) ? outcome.evidence : [];
  const abstained = isAbstainOutcome(outcome);
  const directReply = isDirectReplyOutcome(outcome);

  if (goldCase.expect === 'direct_reply') {
    return {
      pass: directReply,
      falseAbstain: abstained,
      falseAnswer: false,
      precision: 1,
      recall: 1,
      citationPass: true,
    };
  }

  if (goldCase.expect === 'abstain') {
    const falseAnswer = !abstained;
    const inventedCitations = evidence.length > 0 && !abstained;
    return {
      pass: abstained && evidence.length === 0,
      falseAbstain: false,
      falseAnswer: falseAnswer || inventedCitations,
      precision: 1,
      recall: 1,
      citationPass: true,
    };
  }

  // expect === 'answer'
  if (abstained) {
    return {
      pass: false,
      falseAbstain: true,
      falseAnswer: false,
      precision: 0,
      recall: 0,
      citationPass: false,
    };
  }

  if (directReply) {
    // Guard cases must stay grounded — a direct reply without citations is a miss.
    return {
      pass: false,
      falseAbstain: false,
      falseAnswer: false,
      precision: 0,
      recall: 0,
      citationPass: false,
    };
  }

  const citation = scoreCitationCase(goldCase, evidence);
  return {
    pass: citation.citationPass,
    falseAbstain: false,
    falseAnswer: false,
    precision: citation.precision,
    recall: citation.recall,
    citationPass: citation.citationPass,
  };
}

/**
 * Aggregates suite metrics and whether the floor is met.
 * @param {Array<ReturnType<typeof scoreAnswerQualityCase> & { expect: string }>} caseScores Per-case scores with expect.
 * @param {number} [passFloor=0.8] Minimum citation-pass, abstain-pass, and direct-reply rates.
 * @returns {{
 *   meanPrecision: number,
 *   meanRecall: number,
 *   citationPassRate: number,
 *   abstainPassRate: number,
 *   directReplyPassRate: number,
 *   falseAbstainRate: number,
 *   falseAnswerRate: number,
 *   suitePass: boolean,
 * }}
 */
export function aggregateAnswerQualityScores(caseScores, passFloor = 0.8) {
  const rows = Array.isArray(caseScores) ? caseScores : [];
  const answerRows = rows.filter((r) => r.expect === 'answer');
  const abstainRows = rows.filter((r) => r.expect === 'abstain');
  const directReplyRows = rows.filter((r) => r.expect === 'direct_reply');

  const mean = (vals) => (vals.length === 0 ? 1 : vals.reduce((a, b) => a + b, 0) / vals.length);

  const citationPassRate = answerRows.length === 0 ? 1 : answerRows.filter((r) => r.citationPass).length / answerRows.length;
  const abstainPassRate = abstainRows.length === 0 ? 1 : abstainRows.filter((r) => r.pass).length / abstainRows.length;
  const directReplyPassRate =
    directReplyRows.length === 0 ? 1 : directReplyRows.filter((r) => r.pass).length / directReplyRows.length;
  const falseAbstainRate = answerRows.length === 0 ? 0 : answerRows.filter((r) => r.falseAbstain).length / answerRows.length;
  const falseAnswerRate = abstainRows.length === 0 ? 0 : abstainRows.filter((r) => r.falseAnswer).length / abstainRows.length;

  return {
    meanPrecision: mean(answerRows.map((r) => r.precision)),
    meanRecall: mean(answerRows.map((r) => r.recall)),
    citationPassRate,
    abstainPassRate,
    directReplyPassRate,
    falseAbstainRate,
    falseAnswerRate,
    suitePass: citationPassRate >= passFloor && abstainPassRate >= passFloor && directReplyPassRate >= passFloor,
  };
}
