/**
 * Clarification wizard chrome — one question at a time above the composer (frontend §49–§50).
 */
import { useTranslation } from 'react-i18next';
import { ClarificationQuestion } from './ClarificationQuestion.jsx';
import { Loader2 } from 'lucide-react';

/**
 * Renders the active clarification set as a sequential panel.
 * @param {{
 *   wizard: {
 *     active: boolean,
 *     emptySetError: boolean,
 *     followUpNotice: boolean,
 *     currentIndex: number,
 *     questionCount: number,
 *     currentQuestion: object | null,
 *     currentAnswer: string | string[] | undefined,
 *     validationErrorKey: string | null,
 *     isLast: boolean,
 *     canGoBack: boolean,
 *     setAnswer: (value: string | string[]) => void,
 *     goNext: () => boolean,
 *     goBack: () => void,
 *     buildAnswersForSubmit: () => Record<string, string | string[]> | null,
 *   },
 *   submitting?: boolean,
 *   submitError?: string | null,
 *   onSubmit: (answers: Record<string, string | string[]>) => void,
 * }} props Panel props.
 * @returns {import('react').ReactElement | null}
 */
export function ClarificationPanel({ wizard, submitting = false, submitError = null, onSubmit }) {
  const { t } = useTranslation();

  if (wizard.emptySetError) {
    return (
      <div className="border-t border-border bg-background px-4 py-3 sm:px-6" role="alert">
        <div className="mx-auto max-w-3xl text-sm text-destructive">{t('chat.clarification.emptySet')}</div>
      </div>
    );
  }

  if (!wizard.active || !wizard.currentQuestion) {
    return null;
  }

  /**
   * Advances or submits when the current answer is valid.
   */
  function handlePrimary() {
    if (submitting) {
      return;
    }
    if (!wizard.isLast) {
      wizard.goNext();
      return;
    }
    if (!wizard.goNext()) {
      return;
    }
    const answers = wizard.buildAnswersForSubmit();
    if (!answers) {
      return;
    }
    onSubmit(answers);
  }

  return (
    <div className="border-t border-border bg-background px-4 py-3 sm:px-6" aria-busy={submitting} data-testid="clarification-panel">
      <div className="mx-auto max-w-3xl">
        {wizard.followUpNotice ? (
          <p className="mb-2 text-xs text-amber-700" role="status">
            {t('chat.clarification.followUpNotice')}
          </p>
        ) : null}

        <p className="mb-3 text-xs text-muted-foreground">
          {t('chat.clarification.progress', {
            current: wizard.currentIndex + 1,
            total: wizard.questionCount,
          })}
        </p>

        <ClarificationQuestion question={wizard.currentQuestion} value={wizard.currentAnswer} onChange={wizard.setAnswer} disabled={submitting} />

        {wizard.validationErrorKey ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {t(wizard.validationErrorKey, { max: 2000 })}
          </p>
        ) : null}

        {submitError ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {submitError}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {wizard.canGoBack ? (
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
              disabled={submitting}
              onClick={() => wizard.goBack()}
            >
              {t('chat.clarification.back')}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-3 py-1.5 text-sm text-brand-foreground hover:bg-brand/90 disabled:opacity-40"
            disabled={submitting}
            onClick={handlePrimary}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {wizard.isLast ? t('chat.clarification.submit') : t('chat.clarification.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
