/**
 * Distinct trust chrome for assistant supportLevel (not the same as HTTP errors).
 */
import { cn } from '@/shared/lib/utils';
import { useTranslation } from 'react-i18next';
import { Ban, AlertTriangle, CheckCircle2, Scale } from 'lucide-react';

/** Known support levels from the message DTO. */
export const KNOWN_SUPPORT_LEVELS = Object.freeze(['evidence_backed', 'insufficient', 'conflict', 'partial']);

/**
 * @param {{ supportLevel?: string | null, messageStatus?: string | null }} props Banner inputs.
 * @returns {import('react').ReactElement | null}
 */
export default function SupportLevelBanner({ supportLevel, messageStatus }) {
  const { t } = useTranslation();
  const level =
    messageStatus === 'abstained' && (!supportLevel || supportLevel === 'insufficient')
      ? 'insufficient'
      : typeof supportLevel === 'string'
        ? supportLevel
        : null;

  if (!level || level === 'evidence_backed') {
    return null;
  }

  if (level === 'insufficient') {
    return (
      <div
        className={cn('mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900')}
        role="status"
        data-support-level="insufficient"
      >
        <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t('chat.support.insufficient')}</span>
      </div>
    );
  }

  if (level === 'conflict') {
    return (
      <div
        className={cn('mt-2 flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-900')}
        role="status"
        data-support-level="conflict"
      >
        <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t('chat.support.conflict')}</span>
      </div>
    );
  }

  if (level === 'partial') {
    return (
      <div
        className={cn('mt-2 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900')}
        role="status"
        data-support-level="partial"
      >
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t('chat.support.partial')}</span>
      </div>
    );
  }

  return null;
}

/**
 * Optional grounded success hint when product wants explicit confirmation (kept unused by default).
 * @returns {import('react').ReactElement}
 */
export function EvidenceBackedHint() {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground" data-support-level="evidence_backed">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
      {t('chat.support.evidenceBacked')}
    </div>
  );
}
