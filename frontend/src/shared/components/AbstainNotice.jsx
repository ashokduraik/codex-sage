import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { Info, RefreshCw, Search } from 'lucide-react';

/**
 * Notice shown when the assistant abstains due to insufficient project evidence.
 * Retry / narrow buttons render only when the matching callback is provided.
 * @param {{ missing?: string[], onRetry?: () => void, onNarrow?: () => void }} props Abstain notice props.
 * @returns Abstain notice UI.
 */
export default function AbstainNotice({ missing = [], onRetry, onNarrow }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-2.5">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-amber-900">{t('abstain.title')}</p>
          {missing.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800/90">
              {missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {typeof onRetry === 'function' || typeof onNarrow === 'function' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {typeof onNarrow === 'function' ? (
                <Button type="button" size="sm" variant="outline" onClick={onNarrow}>
                  <Search className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  {t('abstain.narrow')}
                </Button>
              ) : null}
              {typeof onRetry === 'function' ? (
                <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  {t('abstain.retry')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
