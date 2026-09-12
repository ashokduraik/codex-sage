import { useTranslation } from 'react-i18next';

/**
 * Inline mutation/query error with optional correlation reference.
 *
 * @param {{ message: string, correlationId?: string }} props Error display props.
 * @returns Error alert element, or null when message is empty.
 */
export function InlineErrorAlert({ message, correlationId = '' }) {
  const { t } = useTranslation();
  if (!message) {
    return null;
  }
  return (
    <div role="alert" className="text-sm text-destructive">
      <p>{message}</p>
      {correlationId ? (
        <p className="mt-1 text-xs opacity-80">
          {t('errors.correlationId', { id: correlationId })}
        </p>
      ) : null}
    </div>
  );
}
