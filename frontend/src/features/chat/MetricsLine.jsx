/**
 * Renders response metrics only for fields present on the message (no placeholders).
 */
import { useTranslation } from 'react-i18next';
import { formatMessageMetrics } from './utils/formatMessageMetrics.js';

/**
 * @param {{ message: object | null | undefined }} props Message with optional usage / durationMs.
 * @returns {import('react').ReactElement | null}
 */
export default function MetricsLine({ message }) {
  const { t, i18n } = useTranslation();
  const metrics = formatMessageMetrics(message);
  if (!metrics) {
    return null;
  }

  const locale = i18n.language || undefined;
  const parts = [];

  if (typeof metrics.durationMs === 'number') {
    const seconds = metrics.durationMs / 1000;
    parts.push(
      t('chat.metrics.duration', {
        value: new Intl.NumberFormat(locale, { maximumFractionDigits: seconds >= 10 ? 0 : 1 }).format(seconds),
      }),
    );
  }
  if (typeof metrics.inputTokens === 'number') {
    parts.push(t('chat.metrics.inputTokens', { count: new Intl.NumberFormat(locale).format(metrics.inputTokens) }));
  }
  if (typeof metrics.outputTokens === 'number') {
    parts.push(t('chat.metrics.outputTokens', { count: new Intl.NumberFormat(locale).format(metrics.outputTokens) }));
  }
  if (typeof metrics.totalTokens === 'number' && metrics.inputTokens == null && metrics.outputTokens == null) {
    parts.push(t('chat.metrics.totalTokens', { count: new Intl.NumberFormat(locale).format(metrics.totalTokens) }));
  }

  if (parts.length === 0) {
    return null;
  }

  return (
    <p className="mt-2 text-[11px] text-muted-foreground" data-testid="metrics-line">
      {parts.join(' · ')}
    </p>
  );
}
