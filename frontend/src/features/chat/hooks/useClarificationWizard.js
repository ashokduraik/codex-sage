/**
 * Local one-at-a-time clarification wizard with sessionStorage persistence (frontend §50–§52).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CLARIFICATION_FREE_TEXT_MAX_LENGTH } from '@/features/chat/api/clarificationsApi.js';

/** sessionStorage key prefix for in-progress wizard answers. */
export const CLARIFICATION_SESSION_KEY_PREFIX = 'codex-sage.clarification.';

/**
 * @typedef {object} ClarificationQuestion
 * @property {string} id Question id (answer map key).
 * @property {'single_select' | 'multi_select' | 'free_text' | string} type Control type.
 * @property {string} prompt User-facing prompt.
 * @property {string[]} [options] Select options.
 * @property {boolean} [required] Default true when omitted.
 */

/**
 * @typedef {object} ClarificationSetPayload
 * @property {string} clarificationSetId Public set id.
 * @property {number} [roundIndex] 0 or 1.
 * @property {ClarificationQuestion[]} questions Full question list.
 * @property {string} [messageId] Assistant message id when known from SSE.
 */

/**
 * Builds the sessionStorage key for a conversation + set.
 * @param {string} conversationId Conversation id.
 * @param {string} clarificationSetId Set id.
 * @returns {string}
 */
export function clarificationSessionKey(conversationId, clarificationSetId) {
  return `${CLARIFICATION_SESSION_KEY_PREFIX}${conversationId}:${clarificationSetId}`;
}

/**
 * Reads persisted wizard progress from sessionStorage.
 * @param {string} conversationId Conversation id.
 * @param {string} clarificationSetId Set id.
 * @returns {{ currentIndex: number, answersByQuestionId: Record<string, string | string[]> } | null}
 */
export function loadClarificationSession(conversationId, clarificationSetId) {
  if (typeof sessionStorage === 'undefined' || !conversationId || !clarificationSetId) {
    return null;
  }
  try {
    const raw = sessionStorage.getItem(clarificationSessionKey(conversationId, clarificationSetId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const currentIndex = typeof parsed.currentIndex === 'number' ? parsed.currentIndex : 0;
    const answersByQuestionId = parsed.answersByQuestionId && typeof parsed.answersByQuestionId === 'object' ? parsed.answersByQuestionId : {};
    return { currentIndex, answersByQuestionId };
  } catch {
    return null;
  }
}

/**
 * Writes wizard progress to sessionStorage.
 * @param {string} conversationId Conversation id.
 * @param {string} clarificationSetId Set id.
 * @param {{ currentIndex: number, answersByQuestionId: Record<string, string | string[]> }} state Progress.
 */
export function saveClarificationSession(conversationId, clarificationSetId, state) {
  if (typeof sessionStorage === 'undefined' || !conversationId || !clarificationSetId) {
    return;
  }
  try {
    sessionStorage.setItem(clarificationSessionKey(conversationId, clarificationSetId), JSON.stringify(state));
  } catch {
    // Quota or private mode — wizard still works in memory.
  }
}

/**
 * Removes persisted progress for a set.
 * @param {string} conversationId Conversation id.
 * @param {string} clarificationSetId Set id.
 */
export function clearClarificationSession(conversationId, clarificationSetId) {
  if (typeof sessionStorage === 'undefined' || !conversationId || !clarificationSetId) {
    return;
  }
  try {
    sessionStorage.removeItem(clarificationSessionKey(conversationId, clarificationSetId));
  } catch {
    // ignore
  }
}

/**
 * Validates the current question's answer for Next / Submit.
 * @param {ClarificationQuestion | null | undefined} question Question.
 * @param {string | string[] | undefined} answer Draft answer.
 * @returns {string | null} i18n key for the error, or null when valid.
 */
export function validateClarificationAnswer(question, answer) {
  if (!question) {
    return 'chat.clarification.emptySet';
  }
  const required = question.required !== false;
  const type = question.type;

  if (type === 'single_select') {
    if (typeof answer !== 'string' || !answer) {
      return required ? 'chat.clarification.validationRequired' : null;
    }
    const options = Array.isArray(question.options) ? question.options : [];
    if (!options.includes(answer)) {
      return 'chat.clarification.validationRequired';
    }
    return null;
  }

  if (type === 'multi_select') {
    const values = Array.isArray(answer) ? answer : [];
    if (required && values.length < 1) {
      return 'chat.clarification.validationMultiRequired';
    }
    const options = Array.isArray(question.options) ? question.options : [];
    if (values.some((value) => !options.includes(value))) {
      return 'chat.clarification.validationRequired';
    }
    return null;
  }

  if (type === 'free_text') {
    const text = typeof answer === 'string' ? answer.trim() : '';
    if (required && !text) {
      return 'chat.clarification.validationRequired';
    }
    if (text.length > CLARIFICATION_FREE_TEXT_MAX_LENGTH) {
      return 'chat.clarification.validationTooLong';
    }
    return null;
  }

  return 'chat.clarification.validationRequired';
}

/**
 * Hook: one-at-a-time clarification wizard state + session persistence.
 * @param {{
 *   conversationId: string | null,
 *   setPayload: ClarificationSetPayload | null,
 *   followUpNotice?: boolean,
 * }} input Active set from stream or listMessages embed.
 * @returns {{
 *   active: boolean,
 *   emptySetError: boolean,
 *   followUpNotice: boolean,
 *   currentIndex: number,
 *   questionCount: number,
 *   currentQuestion: ClarificationQuestion | null,
 *   currentAnswer: string | string[] | undefined,
 *   answersByQuestionId: Record<string, string | string[]>,
 *   validationErrorKey: string | null,
 *   isLast: boolean,
 *   canGoBack: boolean,
 *   setAnswer: (value: string | string[]) => void,
 *   goNext: () => boolean,
 *   goBack: () => void,
 *   buildAnswersForSubmit: () => Record<string, string | string[]> | null,
 *   clear: () => void,
 * }}
 */
export function useClarificationWizard(input) {
  const conversationId = input.conversationId ? String(input.conversationId) : '';
  const setPayload = input.setPayload;
  const setId = setPayload?.clarificationSetId ? String(setPayload.clarificationSetId) : '';
  const questions = useMemo(() => (Array.isArray(setPayload?.questions) ? setPayload.questions : []), [setPayload]);
  const emptySetError = Boolean(setPayload) && questions.length === 0;

  const [currentIndex, setCurrentIndex] = useState(0);
  const [answersByQuestionId, setAnswersByQuestionId] = useState(/** @type {Record<string, string | string[]>} */ ({}));
  const [validationErrorKey, setValidationErrorKey] = useState(/** @type {string | null} */ (null));
  const [followUpNotice, setFollowUpNotice] = useState(Boolean(input.followUpNotice));
  const [hydratedSetId, setHydratedSetId] = useState('');

  useEffect(() => {
    if (!setId || !conversationId) {
      setHydratedSetId('');
      setCurrentIndex(0);
      setAnswersByQuestionId({});
      setValidationErrorKey(null);
      return;
    }
    if (hydratedSetId === setId) {
      return;
    }
    const previousSetId = hydratedSetId;
    if (previousSetId && previousSetId !== setId) {
      clearClarificationSession(conversationId, previousSetId);
      setFollowUpNotice(true);
    } else {
      setFollowUpNotice(Boolean(input.followUpNotice));
    }
    const restored = loadClarificationSession(conversationId, setId);
    setCurrentIndex(restored?.currentIndex ?? 0);
    setAnswersByQuestionId(restored?.answersByQuestionId ?? {});
    setValidationErrorKey(null);
    setHydratedSetId(setId);
  }, [setId, conversationId, hydratedSetId, input.followUpNotice]);

  useEffect(() => {
    if (!conversationId || !setId || hydratedSetId !== setId) {
      return;
    }
    saveClarificationSession(conversationId, setId, { currentIndex, answersByQuestionId });
  }, [conversationId, setId, hydratedSetId, currentIndex, answersByQuestionId]);

  const currentQuestion = questions[currentIndex] ?? null;
  const currentAnswer = currentQuestion ? answersByQuestionId[currentQuestion.id] : undefined;
  const isLast = questions.length > 0 && currentIndex >= questions.length - 1;
  const canGoBack = currentIndex > 0;
  const active = Boolean(setPayload) && !emptySetError && questions.length > 0;

  /**
   * Updates the draft answer for the current question.
   * @param {string | string[]} value Answer value.
   */
  const setAnswer = useCallback(
    (value) => {
      if (!currentQuestion) {
        return;
      }
      setAnswersByQuestionId((prev) => ({ ...prev, [currentQuestion.id]: value }));
      setValidationErrorKey(null);
    },
    [currentQuestion],
  );

  /**
   * Validates the current answer and advances when valid.
   * @returns {boolean} True when advanced (or ready to submit on last).
   */
  const goNext = useCallback(() => {
    const errorKey = validateClarificationAnswer(currentQuestion, currentAnswer);
    if (errorKey) {
      setValidationErrorKey(errorKey);
      return false;
    }
    setValidationErrorKey(null);
    if (!isLast) {
      setCurrentIndex((idx) => idx + 1);
    }
    return true;
  }, [currentQuestion, currentAnswer, isLast]);

  /**
   * Moves to the previous question without clearing answers.
   */
  const goBack = useCallback(() => {
    setValidationErrorKey(null);
    setCurrentIndex((idx) => Math.max(0, idx - 1));
  }, []);

  /**
   * Builds the full answers map after validating every required question.
   * @returns {Record<string, string | string[]> | null} Answers or null when invalid.
   */
  const buildAnswersForSubmit = useCallback(() => {
    /** @type {Record<string, string | string[]>} */
    const answers = {};
    for (let i = 0; i < questions.length; i += 1) {
      const question = questions[i];
      const answer = answersByQuestionId[question.id];
      const errorKey = validateClarificationAnswer(question, answer);
      if (errorKey) {
        setCurrentIndex(i);
        setValidationErrorKey(errorKey);
        return null;
      }
      if (question.type === 'free_text' && typeof answer === 'string') {
        answers[question.id] = answer.trim();
      } else if (answer !== undefined) {
        answers[question.id] = answer;
      }
    }
    return answers;
  }, [questions, answersByQuestionId]);

  /**
   * Clears wizard memory and session storage for the active set.
   */
  const clear = useCallback(() => {
    if (conversationId && setId) {
      clearClarificationSession(conversationId, setId);
    }
    setCurrentIndex(0);
    setAnswersByQuestionId({});
    setValidationErrorKey(null);
    setFollowUpNotice(false);
    setHydratedSetId('');
  }, [conversationId, setId]);

  return {
    active,
    emptySetError,
    followUpNotice,
    currentIndex,
    questionCount: questions.length,
    currentQuestion,
    currentAnswer,
    answersByQuestionId,
    validationErrorKey,
    isLast,
    canGoBack,
    setAnswer,
    goNext,
    goBack,
    buildAnswersForSubmit,
    clear,
  };
}
