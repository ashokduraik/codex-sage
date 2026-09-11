import { useMemo, useState } from 'react';
import { Search, ScrollText, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/shared/ui/input';
import { Button } from '@/shared/ui/button';
import { formatDateTime } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { useAppData } from '@/shared/mock-data';
/**
 * Filterable organization audit log.
 *
 * @returns Admin audit page
 */
export default function AdminAudit() {
    const { t } = useTranslation();
    const { audit } = useAppData();
    const [query, setQuery] = useState('');
    const [result, setResult] = useState('all');
    const [open, setOpen] = useState(null);
    const filtered = useMemo(() => audit.filter((entry) => {
        if (result !== 'all' && entry.result !== result)
            return false;
        if (query &&
            !(entry.actor + entry.action + entry.target)
                .toLowerCase()
                .includes(query.toLowerCase())) {
            return false;
        }
        return true;
    }), [audit, query, result]);
    /**
     * Map an audit result to badge tone classes.
     *
     * @param value - Result label
     * @returns CSS class string
     */
    const resultTone = (value) => value === 'Success'
        ? 'text-emerald-700 bg-emerald-100'
        : value === 'Partial'
            ? 'text-amber-700 bg-amber-100'
            : 'text-red-700 bg-red-100';
    return (<div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-brand" aria-hidden="true"/>
          <h1 className="font-display text-xl font-medium">
            {t('admin.auditTitle')}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('admin.auditSubtitle')}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true"/>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('admin.auditSearch')} className="pl-8"/>
          </div>
          <div className="flex gap-1">
            {['all', 'Success', 'Partial', 'Failed'].map((filter) => (<Button key={filter} size="sm" variant={result === filter ? 'default' : 'outline'} onClick={() => setResult(filter)}>
                {filter === 'all' ? t('home.all') : filter}
              </Button>))}
          </div>
        </div>

        <div className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
          {filtered.map((entry) => (<div key={entry.id}>
              <button type="button" onClick={() => setOpen(open === entry.id ? null : entry.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30">
                {open === entry.id ? (<ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true"/>) : (<ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true"/>)}
                <div className="min-w-0 flex-1">
                  <div className="text-sm">
                    <span className="font-medium">{entry.actor}</span>{' '}
                    <span className="text-muted-foreground">
                      {entry.action.toLowerCase()}
                    </span>{' '}
                    <span className="font-medium">{entry.target}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDateTime(entry.timestamp)}
                  </div>
                </div>
                <span className={cn('rounded-full px-2 py-0.5 text-xs', resultTone(entry.result))}>
                  {entry.result}
                </span>
              </button>
              {open === entry.id && (<div className="px-4 pb-3 pl-11 text-xs text-muted-foreground">
                  <div>
                    {t('admin.auditActor')}: {entry.actor}
                  </div>
                  <div>
                    {t('admin.auditAction')}: {entry.action}
                  </div>
                  <div>
                    {t('admin.auditTarget')}: {entry.target}
                  </div>
                  <div>
                    {t('admin.auditTimestamp')}:{' '}
                    {formatDateTime(entry.timestamp)}
                  </div>
                  <div>
                    {t('admin.auditResult')}: {entry.result}
                  </div>
                  {entry.ref && (<div>
                      {t('admin.auditReference')}: {entry.ref}
                    </div>)}
                </div>)}
            </div>))}
          {filtered.length === 0 && (<div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('admin.auditEmpty')}
            </div>)}
        </div>
      </div>
    </div>);
}
