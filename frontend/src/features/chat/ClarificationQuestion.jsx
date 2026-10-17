/**
 * Type-specific clarification control (single_select, multi_select, free_text).
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CLARIFICATION_FREE_TEXT_MAX_LENGTH } from '@/features/chat/api/clarificationsApi.js';

/**
 * Renders one clarification question's input controls.
 * @param {{
 *   question: {
 *     id: string,
 *     type: string,
 *     prompt: string,
 *     options?: string[],
 *     required?: boolean,
 *   },
 *   value: string | string[] | undefined,
 *   onChange: (value: string | string[]) => void,
 *   disabled?: boolean,
 * }} props Control props.
 * @returns {import('react').ReactElement | null}
 */
export function ClarificationQuestion({ question, value, onChange, disabled = false }) {
  const { t } = useTranslation();
  const firstControlRef = useRef(/** @type {HTMLElement | null} */ (null));

  useEffect(() => {
    firstControlRef.current?.focus();
  }, [question?.id]);

  if (!question) {
    return null;
  }

  const options = Array.isArray(question.options) ? question.options : [];
  const groupName = `clarification-${question.id}`;

  if (question.type === 'single_select') {
    const selected = typeof value === 'string' ? value : '';
    return (
      <fieldset className="w-full min-w-0" disabled={disabled}>
        <legend className="mb-3 text-sm font-medium text-foreground">{question.prompt}</legend>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label={question.prompt}>
          {options.map((option, index) => {
            const optionId = `${groupName}-${index}`;
            return (
              <label
                key={option}
                htmlFor={optionId}
                className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <input
                  ref={index === 0 ? firstControlRef : undefined}
                  id={optionId}
                  type="radio"
                  name={groupName}
                  value={option}
                  checked={selected === option}
                  disabled={disabled}
                  onChange={() => onChange(option)}
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0 break-words">{option}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (question.type === 'multi_select') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="w-full min-w-0" disabled={disabled}>
        <legend className="mb-3 text-sm font-medium text-foreground">{question.prompt}</legend>
        <div className="flex flex-col gap-2" role="group" aria-label={question.prompt}>
          {options.map((option, index) => {
            const optionId = `${groupName}-${index}`;
            const checked = selected.includes(option);
            return (
              <label
                key={option}
                htmlFor={optionId}
                className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <input
                  ref={index === 0 ? firstControlRef : undefined}
                  id={optionId}
                  type="checkbox"
                  name={groupName}
                  value={option}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    if (checked) {
                      onChange(selected.filter((item) => item !== option));
                    } else {
                      onChange([...selected, option]);
                    }
                  }}
                  className="mt-0.5 shrink-0"
                />
                <span className="min-w-0 break-words">{option}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }

  if (question.type === 'free_text') {
    const text = typeof value === 'string' ? value : '';
    return (
      <div className="w-full min-w-0">
        <label htmlFor={groupName} className="mb-3 block text-sm font-medium text-foreground">
          {question.prompt}
        </label>
        <textarea
          ref={firstControlRef}
          id={groupName}
          value={text}
          disabled={disabled}
          maxLength={CLARIFICATION_FREE_TEXT_MAX_LENGTH}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t('chat.clarification.freeTextPlaceholder')}
          className="w-full min-w-0 resize-y rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/30"
        />
      </div>
    );
  }

  return (
    <p className="text-sm text-destructive" role="alert">
      {t('chat.clarification.unsupportedType')}
    </p>
  );
}
