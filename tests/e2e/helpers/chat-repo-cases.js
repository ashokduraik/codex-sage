/**
 * Locked prepayment-advisor chat questions and answer/source matchers for the repo chat journey.
 */

/** Public clone URL for the EMI / prepayment dogfood repo (override via E2E_CHAT_REPO_URL). */
export const DEFAULT_CHAT_REPO_URL = 'https://github.com/ashokduraik/prepayment-advisor.git';

/** Functional product-behavior question about EMI. */
export const E2E_EMI_FUNCTIONAL_QUESTION =
  'How is EMI calculated for the user in this product, from what they enter through to what each month shows?';

/**
 * Answer anchors for the functional EMI ask — require at least {@link E2E_EMI_FUNCTIONAL_MIN_MATCHES}.
 * Broad enough for LLM paraphrase while still requiring loan/EMI product language.
 * @type {RegExp[]}
 */
export const E2E_EMI_FUNCTIONAL_ANSWER_MATCHERS = [
  /getEMIAmount|LoanUtils|calculateLoanDetails|doCalc/i,
  /rate\s*\/\s*12|\/\s*\(\s*12|12\s*[x×*]\s*100|12\s*\*\s*100|monthly\s+rate|\bEMI\b/i,
  /principal|interest|amorti[sz]ation|instal?ment|EMI\s*[-−–]\s*interest/i,
  /flat\s+EMI|prepayment|FLEXI_LOAN|principal\s+mix|balance/i,
];

/** Minimum distinct functional anchors that must appear in the answer. */
export const E2E_EMI_FUNCTIONAL_MIN_MATCHES = 2;

/**
 * Sources for the functional product-behavior ask — LLM may cite UI/calc pages or LoanUtils.
 * @type {RegExp[]}
 */
export const E2E_EMI_FUNCTIONAL_SOURCE_MATCHERS = [/loan\.utils\.ts|calculation-logic|emi-calculator|LoanUtils/i];

/**
 * Sources for technical / formula EMI asks — LoanUtils or the EMI calculator pages.
 * @type {RegExp[]}
 */
export const E2E_EMI_SOURCE_MATCHERS = [/loan\.utils\.ts|emi-calculator|calculation-logic|LoanUtils/i];

/** Technical implementation question about EMI. */
export const E2E_EMI_TECHNICAL_QUESTION = 'Which file and functions implement EMI calculation?';

/**
 * Answer anchors for the technical EMI ask — require at least {@link E2E_EMI_TECHNICAL_MIN_FUNCTION_MATCHES}.
 * @type {RegExp[]}
 */
export const E2E_EMI_TECHNICAL_FUNCTION_MATCHERS = [
  /getEMIAmount/i,
  /getBalanceTermAndInterest/i,
  /fillInstalments/i,
  /calculateLoanDetails/i,
  /doCalc/i,
];

/** File or class mention required for the technical ask. */
export const E2E_EMI_TECHNICAL_FILE_MATCHERS = [/loan\.utils\.ts|LoanUtils|emi-calculator|EmiCalculatorPage/i];

/** Minimum distinct function-name anchors for the technical ask. */
export const E2E_EMI_TECHNICAL_MIN_FUNCTION_MATCHES = 1;

/**
 * Multi-turn follow-up after the technical ask — omits EMI; must use prior-turn file context.
 */
export const E2E_EMI_FOLLOWUP_QUESTION = 'Which file path did you just cite for that calculation?';

/** Follow-up must reuse the prior technical cite (calculator page and/or LoanUtils). */
export const E2E_EMI_FOLLOWUP_ANSWER_MATCHERS = [/emi-calculator|loan\.utils\.ts|LoanUtils|doCalc/i];

/** Domain-ambiguous clarification trigger for the repo journey. */
export const E2E_EMI_CLARIFICATION_QUESTION = 'How should I change my payments for better savings?';
