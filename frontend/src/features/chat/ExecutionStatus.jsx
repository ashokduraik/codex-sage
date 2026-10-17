/**
 * Single-line observable stage label from chat SSE status events (no fabricated CoT).
 */
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { stageToI18nKey } from '@/features/chat/api/chatStreamApi.js';

/**
 * Shows the current execution stage with a polite live region.
 * @param {{ stage: string, className?: string }} props Stage props.
 * @returns {import('react').ReactElement | null}
 */
export function ExecutionStatus({ stage, className }) {
  const { t } = useTranslation();
  if (!stage) {
    return null;
  }
  const label = t(stageToI18nKey(stage));
  return (
    <div className={`flex items-center gap-1.5 text-sm text-muted-foreground ${className || ''}`} aria-live="polite">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export default ExecutionStatus;
